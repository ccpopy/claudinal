use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};

use super::reader::{cwd_matches_jsonl, is_internal_generated_event, project_dirs};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputReceiptQuery {
    pub attempt_id: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedInputReceipt {
    pub attempt_id: String,
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputReceiptScan {
    pub accepted: Vec<AcceptedInputReceipt>,
    pub complete: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Copy)]
struct Limits {
    files: usize,
    entries: usize,
    bytes: usize,
    line_bytes: usize,
    elapsed: Duration,
}

const LIMITS: Limits = Limits {
    files: 128,
    entries: 2048,
    bytes: 32 * 1024 * 1024,
    line_bytes: 32 * 1024 * 1024,
    elapsed: Duration::from_millis(500),
};

struct Budget {
    start: Instant,
    limits: Limits,
    bytes: usize,
    files: usize,
    entries: usize,
}

impl Budget {
    fn check(&self) -> std::result::Result<(), String> {
        if self.start.elapsed() >= self.limits.elapsed {
            return Err("会话接收记录核对超过时间预算；本地输入已保留".into());
        }
        Ok(())
    }
}

/// A receipt must be an exact, complete main user record in the same project.
/// Derived sidecars, assistant text, child forwarding and content equality are
/// deliberately insufficient evidence that this attempt was accepted.
fn main_input_id(value: &Value) -> Option<&str> {
    if value.get("type").and_then(Value::as_str) != Some("user")
        || value.pointer("/message/role").and_then(Value::as_str) != Some("user")
        || !value
            .pointer("/message/content")
            .is_some_and(|content| content.is_string() || content.is_array())
        || is_internal_generated_event(value)
        || [
            "isMeta",
            "is_meta",
            "isSynthetic",
            "is_synthetic",
            "isCompactSummary",
            "is_compact_summary",
            "isSidechain",
        ]
        .iter()
        .any(|key| {
            value
                .get(key)
                .is_some_and(|flag| !flag.is_null() && flag.as_bool() != Some(false))
        })
        || ["agent_id", "parent_tool_use_id"]
            .iter()
            .any(|key| value.get(key).is_some_and(|value| !value.is_null()))
    {
        return None;
    }
    value.get("uuid").and_then(Value::as_str)
}

fn scan_file(
    path: &Path,
    cwd: &str,
    wanted: &HashSet<&str>,
    budget: &mut Budget,
) -> std::result::Result<Vec<String>, String> {
    budget.check()?;
    budget.files += 1;
    if budget.files > budget.limits.files {
        return Err("待核对的会话数量超过预算；本地输入已保留".into());
    }
    let file = std::fs::File::open(path)
        .map_err(|_| "无法读取会话接收记录；本地输入已保留".to_string())?;
    let mut reader = std::io::BufReader::new(file);
    let mut accepted = Vec::new();
    let mut belongs = false;
    let mut line_number = 0;
    loop {
        budget.check()?;
        let remaining = budget.limits.bytes.saturating_sub(budget.bytes);
        if remaining == 0 {
            if reader
                .fill_buf()
                .map_err(|_| "会话读取失败；本地输入已保留")?
                .is_empty()
            {
                break;
            }
            return Err("会话接收记录核对超过字节预算；本地输入已保留".into());
        }
        let cap = budget.limits.line_bytes.min(remaining);
        let mut line = Vec::new();
        let read = reader
            .by_ref()
            .take((cap + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| "会话读取失败；本地输入已保留".to_string())?;
        if read == 0 {
            break;
        }
        budget.bytes += read;
        if read > cap {
            return Err("会话接收记录超过单行或字节预算；本地输入已保留".into());
        }
        if !line.ends_with(b"\n") {
            return Err("会话记录尚有未完成的写入；本地输入已保留".into());
        }
        line_number += 1;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let value: Value = serde_json::from_slice(&line)
            .map_err(|_| "会话记录包含无法核对的内容；本地输入已保留".to_string())?;
        if let Some(record_cwd) = value
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty())
        {
            if !cwd_matches_jsonl(cwd, record_cwd) {
                // Encoded project directory names can collide. Never use the
                // directory name alone as project ownership evidence.
                return Ok(Vec::new());
            }
            if line_number <= 20 {
                belongs = true;
            }
        }
        if line_number > 20 && !belongs {
            return Ok(Vec::new());
        }
        if let Some(id) = main_input_id(&value).filter(|id| wanted.contains(*id)) {
            accepted.push(id.to_string());
        }
    }
    Ok(if belongs { accepted } else { Vec::new() })
}

fn scan_at_dirs(
    cwd: &str,
    queries: &[InputReceiptQuery],
    dirs: &[PathBuf],
    limits: Limits,
) -> InputReceiptScan {
    let mut budget = Budget {
        start: Instant::now(),
        limits,
        bytes: 0,
        files: 0,
        entries: 0,
    };
    let unknown_session = queries.iter().any(|query| query.session_id.is_none());
    let known_sessions: HashSet<&str> = queries
        .iter()
        .filter_map(|query| query.session_id.as_deref())
        .collect();
    let wanted: HashSet<&str> = queries
        .iter()
        .map(|query| query.attempt_id.as_str())
        .collect();
    let mut accepted = HashMap::new();
    let work = (|| -> std::result::Result<(), String> {
        let mut paths = Vec::new();
        for dir in dirs {
            budget.check()?;
            if !unknown_session {
                paths.extend(
                    known_sessions
                        .iter()
                        .map(|id| dir.join(format!("{id}.jsonl")))
                        .filter(|path| path.is_file()),
                );
                continue;
            }
            let entries = match std::fs::read_dir(dir) {
                Ok(entries) => entries,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("无法读取项目会话目录；本地输入已保留".into()),
            };
            for entry in entries {
                budget.check()?;
                budget.entries += 1;
                if budget.entries > limits.entries {
                    return Err("项目会话目录超过核对预算；本地输入已保留".into());
                }
                let path = entry
                    .map_err(|_| "无法读取项目会话目录；本地输入已保留")?
                    .path();
                if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
                    && path.is_file()
                {
                    paths.push(path);
                    if paths.len() > limits.files {
                        return Err("待核对的会话数量超过预算；本地输入已保留".into());
                    }
                }
            }
        }
        paths.sort();
        paths.dedup();
        for path in paths {
            let Some(session_id) = path.file_stem().and_then(|id| id.to_str()) else {
                continue;
            };
            for id in scan_file(&path, cwd, &wanted, &mut budget)? {
                if queries.iter().any(|query| {
                    query.attempt_id == id
                        && query
                            .session_id
                            .as_deref()
                            .is_none_or(|target| target == session_id)
                }) {
                    accepted.insert(id, session_id.to_string());
                }
            }
        }
        budget.check()
    })();
    match work {
        Ok(()) => InputReceiptScan {
            accepted: accepted
                .into_iter()
                .map(|(attempt_id, session_id)| AcceptedInputReceipt {
                    attempt_id,
                    session_id,
                })
                .collect(),
            complete: true,
            reason: None,
        },
        // A partial/read-failed scan is unavailable, never authority to clear
        // the only durable recovery copy.
        Err(reason) => InputReceiptScan {
            accepted: Vec::new(),
            complete: false,
            reason: Some(reason),
        },
    }
}

pub fn find_session_input_receipts(
    cwd: &str,
    queries: &[InputReceiptQuery],
) -> Result<InputReceiptScan> {
    if cwd.trim().is_empty() || !Path::new(cwd).is_absolute() || queries.len() > 50 {
        return Err(Error::Other("invalid input receipt query".into()));
    }
    for query in queries {
        uuid::Uuid::parse_str(&query.attempt_id)
            .map_err(|_| Error::Other("invalid input attempt UUID".into()))?;
        if query.session_id.as_deref().is_some_and(|id| {
            id.is_empty() || id.len() > 128 || id.contains(['/', '\\']) || id.contains("..")
        }) {
            return Err(Error::Other("invalid input receipt session id".into()));
        }
    }
    if queries.is_empty() {
        return Ok(InputReceiptScan {
            accepted: Vec::new(),
            complete: true,
            reason: None,
        });
    }
    Ok(scan_at_dirs(cwd, queries, &project_dirs(cwd)?, LIMITS))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(records: &[Value], complete_last_line: bool) -> (PathBuf, String) {
        let root =
            std::env::temp_dir().join(format!("claudinal-receipts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let cwd = root.join("workspace").display().to_string();
        let mut text = format!("{}\n", json!({"type":"system", "cwd":cwd}));
        for record in records {
            let mut record = record.clone();
            if record.get("type").and_then(Value::as_str) == Some("user") {
                if record.get("message").is_none() {
                    record["message"] = json!({"role":"user", "content":"example"});
                } else if record.pointer("/message/role").is_none() {
                    record["message"]["role"] = json!("user");
                }
            }
            text.push_str(&record.to_string());
            text.push('\n');
        }
        if !complete_last_line {
            text.pop();
        }
        std::fs::write(root.join("session.jsonl"), text).unwrap();
        (root, cwd)
    }

    #[test]
    fn finds_exact_main_attempt_and_unknown_first_session_without_text_matching() {
        let id = uuid::Uuid::new_v4().to_string();
        let (root, cwd) = fixture(
            &[json!({"type":"user", "uuid":id, "message":{"content":"accepted"}})],
            true,
        );
        let queries = [InputReceiptQuery {
            attempt_id: id.clone(),
            session_id: None,
        }];
        let scan = scan_at_dirs(&cwd, &queries, &[root.clone()], LIMITS);
        assert!(scan.complete);
        assert_eq!(scan.accepted.len(), 1);
        assert_eq!(scan.accepted[0].attempt_id, id);
        assert_eq!(scan.accepted[0].session_id, "session");
        let other = [InputReceiptQuery {
            attempt_id: uuid::Uuid::new_v4().to_string(),
            session_id: None,
        }];
        assert!(scan_at_dirs(&cwd, &other, &[root.clone()], LIMITS)
            .accepted
            .is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn excludes_forwarding_internal_and_other_project_or_session_records() {
        let id = uuid::Uuid::new_v4().to_string();
        for field in ["agent_id", "parent_tool_use_id", "isMeta", "isSidechain"] {
            let mut record = json!({"type":"user", "uuid":id});
            record[field] = if field.starts_with("is") {
                json!(true)
            } else {
                json!("child")
            };
            let (root, cwd) = fixture(&[record], true);
            let queries = [InputReceiptQuery {
                attempt_id: id.clone(),
                session_id: None,
            }];
            assert!(scan_at_dirs(&cwd, &queries, &[root.clone()], LIMITS)
                .accepted
                .is_empty());
            std::fs::remove_dir_all(root).unwrap();
        }
        for record in [
            json!({"type":"assistant", "uuid":id}),
            json!({"type":"user", "uuid":id, "message":{"role":"assistant", "content":"wrong role"}}),
            json!({"type":"user", "uuid":id, "isSidechain":"true"}),
            json!({"type":"user", "uuid":id, "isMeta":1}),
            json!({"type":"user", "uuid":id, "origin":{"kind":"task-notification"}}),
            json!({"type":"user", "uuid":id, "message":{"content":[{"type":"tool_result"}]}}),
        ] {
            let (root, cwd) = fixture(&[record], true);
            let queries = [InputReceiptQuery {
                attempt_id: id.clone(),
                session_id: None,
            }];
            assert!(scan_at_dirs(&cwd, &queries, &[root.clone()], LIMITS)
                .accepted
                .is_empty());
            std::fs::remove_dir_all(root).unwrap();
        }
        let (root, cwd) = fixture(&[json!({"type":"user", "uuid":id})], true);
        let queries = [InputReceiptQuery {
            attempt_id: id,
            session_id: Some("other".into()),
        }];
        assert!(scan_at_dirs(&cwd, &queries, &[root.clone()], LIMITS)
            .accepted
            .is_empty());
        let unknown = [InputReceiptQuery {
            attempt_id: queries[0].attempt_id.clone(),
            session_id: None,
        }];
        assert!(
            scan_at_dirs(&format!("{cwd}-other"), &unknown, &[root.clone()], LIMITS)
                .accepted
                .is_empty()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incomplete_or_budget_limited_scans_never_publish_receipts() {
        let id = uuid::Uuid::new_v4().to_string();
        let queries = [InputReceiptQuery {
            attempt_id: id.clone(),
            session_id: None,
        }];
        let (root, cwd) = fixture(&[json!({"type":"user", "uuid":id})], false);
        assert!(!scan_at_dirs(&cwd, &queries, &[root.clone()], LIMITS).complete);
        std::fs::write(
            root.join("session.jsonl"),
            format!("{}\n", json!({"type":"user", "cwd":cwd, "uuid":id})),
        )
        .unwrap();
        for limits in [
            Limits {
                bytes: 16,
                ..LIMITS
            },
            Limits { files: 0, ..LIMITS },
            Limits {
                entries: 0,
                ..LIMITS
            },
            Limits {
                elapsed: Duration::ZERO,
                ..LIMITS
            },
            Limits {
                line_bytes: 16,
                ..LIMITS
            },
        ] {
            let scan = scan_at_dirs(&cwd, &queries, &[root.clone()], limits);
            assert!(!scan.complete);
            assert!(scan.accepted.is_empty());
            assert!(scan.reason.is_some());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_records_and_nested_child_files_cannot_clear_recovery() {
        let id = uuid::Uuid::new_v4().to_string();
        let queries = [InputReceiptQuery {
            attempt_id: id.clone(),
            session_id: None,
        }];
        let (root, cwd) = fixture(&[json!({"type":"user", "uuid":id})], true);
        let text = std::fs::read_to_string(root.join("session.jsonl")).unwrap();
        std::fs::write(root.join("session.jsonl"), format!("{text}malformed\n")).unwrap();
        let malformed = scan_at_dirs(&cwd, &queries, &[root.clone()], LIMITS);
        assert!(!malformed.complete);
        assert!(malformed.accepted.is_empty());
        std::fs::write(
            root.join("session.jsonl"),
            format!("{}\n", json!({"type":"system", "cwd":cwd})),
        )
        .unwrap();
        let children = root.join("session").join("subagents");
        std::fs::create_dir_all(&children).unwrap();
        std::fs::write(
            children.join("agent-child.jsonl"),
            format!("{}\n", json!({"type":"user", "uuid":id, "cwd":cwd})),
        )
        .unwrap();
        let child = scan_at_dirs(&cwd, &queries, &[root.clone()], LIMITS);
        assert!(child.complete);
        assert!(child.accepted.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_invalid_public_query_before_reading_real_projects() {
        assert!(find_session_input_receipts("relative", &[]).is_err());
        assert!(find_session_input_receipts(
            &std::env::temp_dir().display().to_string(),
            &[InputReceiptQuery {
                attempt_id: "not-a-uuid".into(),
                session_id: None
            }]
        )
        .is_err());
    }
}
