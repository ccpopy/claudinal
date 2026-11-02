//! In-process unified line diff for review snapshots. Produces the same hunk
//! shape `parse_git_patch` extracts from `git diff --no-index --unified=80`,
//! comparing CRLF as LF while preserving missing final newlines.
use crate::commands::DiffHunk;
use similar::{capture_diff_slices_deadline, group_diff_ops, Algorithm, DiffTag};
use std::time::Instant;

/// Matches `--unified=80`.
const CONTEXT_LINES: usize = 80;
/// Bounds encoded hunk lines and frontend row count across the review's files.
pub(crate) struct OutputBudget {
    lines: usize,
    bytes: usize,
}

impl Default for OutputBudget {
    fn default() -> Self {
        Self {
            lines: 200_000,
            bytes: 8 * 1024 * 1024,
        }
    }
}
/// Git sniffs the first 8000 bytes for NUL to decide a file is binary.
const BINARY_SNIFF_BYTES: usize = 8000;
const NO_NEWLINE_MARKER: &str = "\\ No newline at end of file";

pub(crate) struct DiffOutcome {
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
    /// Hunk lines were capped at the output budget; counts still cover the whole file.
    pub truncated: bool,
    /// Rows emitted into `hunks`, including no-newline markers.
    pub shown_lines: u32,
    /// The deadline passed mid-diff. Past it similar only yields a coarse
    /// whole-file replace, so no hunks or counts are reported.
    pub timed_out: bool,
}

/// One logical line: text without its LF/CRLF, plus whether it was terminated.
/// Git treats a missing final newline as a difference, so it is part of the key.
#[derive(PartialEq, Eq, Hash)]
struct Line<'a> {
    text: &'a str,
    newline: bool,
}

fn split_lines(text: &str) -> Vec<Line<'_>> {
    text.split_inclusive('\n')
        .map(|raw| {
            let newline = raw.ends_with('\n');
            let raw = raw.strip_suffix('\n').unwrap_or(raw);
            // Only normalize CRLF. A bare CR is content, and Git's
            // --ignore-cr-at-eol also hides final-newline changes we must show.
            let text = if newline {
                raw.strip_suffix('\r').unwrap_or(raw)
            } else {
                raw
            };
            Line { text, newline }
        })
        .collect()
}

pub(crate) fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

fn hunk_start(index: usize, lines: u32) -> u32 {
    // Unified diff convention: an empty range names the line before it.
    if lines == 0 {
        index as u32
    } else {
        index as u32 + 1
    }
}

pub(crate) fn diff_texts(
    old: &[u8],
    new: &[u8],
    deadline: Instant,
    budget: &mut OutputBudget,
) -> DiffOutcome {
    if is_binary(old) || is_binary(new) {
        return DiffOutcome {
            additions: 0,
            deletions: 0,
            binary: true,
            hunks: Vec::new(),
            truncated: false,
            shown_lines: 0,
            timed_out: false,
        };
    }
    let old_text = String::from_utf8_lossy(old);
    let new_text = String::from_utf8_lossy(new);
    let old_lines = split_lines(&old_text);
    let new_lines = split_lines(&new_text);
    // Patience anchors on unique lines (signatures, distinctive statements),
    // which keeps code hunks aligned better than plain Myers around repeated
    // braces/blank lines.
    let ops =
        capture_diff_slices_deadline(Algorithm::Patience, &old_lines, &new_lines, Some(deadline));
    if Instant::now() >= deadline {
        return DiffOutcome {
            additions: 0,
            deletions: 0,
            binary: false,
            hunks: Vec::new(),
            truncated: false,
            shown_lines: 0,
            timed_out: true,
        };
    }

    let mut additions = 0u32;
    let mut deletions = 0u32;
    for op in &ops {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        if tag != DiffTag::Equal {
            deletions += old_range.len() as u32;
            additions += new_range.len() as u32;
        }
    }

    let mut hunks = Vec::new();
    let mut file_rows = 0;
    let mut truncated = false;
    'groups: for group in group_diff_ops(ops, CONTEXT_LINES) {
        let Some(first) = group.first() else {
            continue;
        };
        let old_index = first.old_range().start;
        let new_index = first.new_range().start;
        let mut lines = Vec::new();
        let mut old_count = 0u32;
        let mut new_count = 0u32;
        let mut push = |lines: &mut Vec<String>, prefix: char, line: &Line<'_>| -> bool {
            // Count JSON escaping as well as text. File snapshots cap raw bytes;
            // line arrays and control characters can multiply the IPC payload.
            let bytes = 4
                + line
                    .text
                    .chars()
                    .map(|c| match c {
                        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
                        c if c < ' ' => 6,
                        c => c.len_utf8(),
                    })
                    .sum::<usize>()
                + if line.newline {
                    0
                } else {
                    NO_NEWLINE_MARKER.len() + 4
                };
            let rows = if line.newline { 1 } else { 2 };
            if file_rows + rows > 50_000 || budget.lines < rows || budget.bytes < bytes {
                return false;
            }
            budget.lines -= rows;
            budget.bytes -= bytes;
            file_rows += rows;
            let mut text = String::with_capacity(line.text.len() + 1);
            text.push(prefix);
            text.push_str(line.text);
            lines.push(text);
            if !line.newline {
                lines.push(NO_NEWLINE_MARKER.to_string());
            }
            true
        };
        let mut full = true;
        for op in &group {
            let (tag, old_range, new_range) = op.as_tag_tuple();
            match tag {
                DiffTag::Equal => {
                    for line in &old_lines[old_range] {
                        if !push(&mut lines, ' ', line) {
                            full = false;
                            break;
                        }
                        old_count += 1;
                        new_count += 1;
                    }
                }
                _ => {
                    for line in &old_lines[old_range] {
                        if !push(&mut lines, '-', line) {
                            full = false;
                            break;
                        }
                        old_count += 1;
                    }
                    if full {
                        for line in &new_lines[new_range] {
                            if !push(&mut lines, '+', line) {
                                full = false;
                                break;
                            }
                            new_count += 1;
                        }
                    }
                }
            }
            if !full {
                break;
            }
        }
        if !lines.is_empty() {
            hunks.push(DiffHunk {
                old_start: hunk_start(old_index, old_count),
                old_lines: old_count,
                new_start: hunk_start(new_index, new_count),
                new_lines: new_count,
                lines,
            });
        }
        if !full {
            truncated = true;
            break 'groups;
        }
    }

    DiffOutcome {
        additions,
        deletions,
        binary: false,
        hunks,
        truncated,
        shown_lines: file_rows as u32,
        timed_out: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff_texts(old: &[u8], new: &[u8], deadline: Instant) -> DiffOutcome {
        super::diff_texts(old, new, deadline, &mut OutputBudget::default())
    }

    fn diff_texts_with_limit(
        old: &[u8],
        new: &[u8],
        deadline: Instant,
        lines: usize,
    ) -> DiffOutcome {
        super::diff_texts(
            old,
            new,
            deadline,
            &mut OutputBudget {
                lines,
                ..OutputBudget::default()
            },
        )
    }
    use std::time::Duration;

    fn far() -> Instant {
        Instant::now() + Duration::from_secs(30)
    }

    fn logical(text: &str) -> Vec<String> {
        split_lines(text)
            .into_iter()
            .map(|line| line.text.to_string())
            .collect()
    }

    /// Applies hunks to the old lines; also checks context/deletions match old.
    fn apply(old: &str, hunks: &[DiffHunk]) -> Vec<String> {
        let old = logical(old);
        let mut out = Vec::new();
        let mut cursor = 0usize;
        for hunk in hunks {
            let start = if hunk.old_lines == 0 {
                hunk.old_start as usize
            } else {
                hunk.old_start as usize - 1
            };
            assert!(start >= cursor, "hunks must be ordered and disjoint");
            out.extend_from_slice(&old[cursor..start]);
            cursor = start;
            let (mut old_seen, mut new_seen) = (0u32, 0u32);
            for line in &hunk.lines {
                let (mark, text) = line.split_at(1);
                match mark {
                    " " => {
                        assert_eq!(old[cursor], text);
                        out.push(text.to_string());
                        cursor += 1;
                        old_seen += 1;
                        new_seen += 1;
                    }
                    "-" => {
                        assert_eq!(old[cursor], text);
                        cursor += 1;
                        old_seen += 1;
                    }
                    "+" => {
                        out.push(text.to_string());
                        new_seen += 1;
                    }
                    "\\" => assert_eq!(line, NO_NEWLINE_MARKER),
                    other => panic!("unexpected line prefix {other:?}"),
                }
            }
            assert_eq!(old_seen, hunk.old_lines);
            assert_eq!(new_seen, hunk.new_lines);
        }
        out.extend_from_slice(&old[cursor..]);
        out
    }

    fn count(hunks: &[DiffHunk], prefix: char) -> u32 {
        hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .filter(|line| line.starts_with(prefix))
            .count() as u32
    }

    fn numbered(count: usize, prefix: &str) -> String {
        (0..count).map(|i| format!("{prefix}{i}\n")).collect()
    }

    fn fixtures() -> Vec<(&'static str, String, String)> {
        let base = numbered(300, "line ");
        let inserted = base.replacen("line 150\n", "line 150\ninserted A\ninserted B\n", 1);
        let deleted = base.replacen("line 10\nline 11\n", "", 1);
        let modified = base.replacen("line 5\n", "line five\n", 1).replacen(
            "line 290\n",
            "line two-ninety\n",
            1,
        );
        vec![
            ("insert", base.clone(), inserted),
            ("delete", base.clone(), deleted),
            ("modify", base.clone(), modified),
            ("empty to content", String::new(), "a\nb\nc\n".into()),
            ("content to empty", "a\nb\nc\n".into(), String::new()),
            (
                "old no trailing newline",
                "a\nb\nc".into(),
                "a\nb\nc\nd\n".into(),
            ),
            (
                "new no trailing newline",
                "a\nb\nc\n".into(),
                "a\nB\nc".into(),
            ),
            ("both no trailing newline", "a\nb".into(), "a\nc".into()),
            (
                "only trailing newline added",
                "a\nb".into(),
                "a\nb\n".into(),
            ),
            (
                "crlf vs lf with edits",
                "one\r\ntwo\r\nthree\r\nfour\r\n".into(),
                "one\ntwo changed\nthree\nfour\nfive\n".into(),
            ),
            (
                "mixed endings",
                "a\r\nb\nc\r\nd\n".into(),
                "a\nb\r\nX\r\nd\r\n".into(),
            ),
            (
                "unicode",
                "你好\n世界 🌍\nnaïve café\n".into(),
                "你好\n世界 🌏\nnaïve café\n结束\n".into(),
            ),
        ]
    }

    #[test]
    fn hunks_round_trip_and_counts_match_lines() {
        for (name, old, new) in fixtures() {
            let outcome = diff_texts(old.as_bytes(), new.as_bytes(), far());
            assert!(!outcome.binary, "{name}");
            assert!(!outcome.truncated, "{name}");
            assert_eq!(apply(&old, &outcome.hunks), logical(&new), "{name}");
            assert_eq!(outcome.additions, count(&outcome.hunks, '+'), "{name}");
            assert_eq!(outcome.deletions, count(&outcome.hunks, '-'), "{name}");
            assert!(
                outcome
                    .hunks
                    .iter()
                    .flat_map(|hunk| &hunk.lines)
                    .all(|line| !line.contains('\r') && !line.contains('\n')),
                "{name}"
            );
        }
    }

    #[test]
    fn hunk_headers_follow_git_conventions() {
        let outcome = diff_texts(b"", b"a\nb\n", far());
        assert_eq!(outcome.hunks.len(), 1);
        let hunk = &outcome.hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (0, 0, 1, 2)
        );
        let outcome = diff_texts(b"a\nb\n", b"", far());
        let hunk = &outcome.hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (1, 2, 0, 0)
        );
        let outcome = diff_texts(b"a\nb", b"a\nb\n", far());
        assert_eq!(
            outcome.hunks[0].lines,
            vec![" a", "-b", NO_NEWLINE_MARKER, "+b"]
        );
        // Changes far apart split into separate hunks with 80 lines of context.
        let old = numbered(1000, "l");
        let new = old
            .replacen("l100\n", "x\n", 1)
            .replacen("l900\n", "y\n", 1);
        let outcome = diff_texts(old.as_bytes(), new.as_bytes(), far());
        assert_eq!(outcome.hunks.len(), 2);
        let hunk = &outcome.hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (21, 161, 21, 161)
        );
        assert!(diff_texts(b"same\r\n", b"same\n", far()).hunks.is_empty());
    }

    #[test]
    fn binary_detection_uses_nul_in_first_8000_bytes() {
        let outcome = diff_texts(b"text\n", b"bin\0ary", far());
        assert!(outcome.binary);
        assert!(outcome.hunks.is_empty());
        assert_eq!((outcome.additions, outcome.deletions), (0, 0));
        let mut late = vec![b'a'; BINARY_SNIFF_BYTES];
        late.push(0);
        assert!(!is_binary(&late));
        assert!(is_binary(&late[BINARY_SNIFF_BYTES - 10..]));
    }

    #[test]
    fn line_cap_truncates_hunks_but_keeps_counts() {
        let new = numbered(500, "n");
        let outcome = diff_texts_with_limit(b"", new.as_bytes(), far(), 100);
        assert!(outcome.truncated);
        assert_eq!(outcome.additions, 500);
        assert_eq!(count(&outcome.hunks, '+'), 100);
        assert_eq!(outcome.hunks[0].new_lines, 100);
        assert_eq!(outcome.shown_lines, 100);
        let outcome = diff_texts_with_limit(b"", new.as_bytes(), far(), 500);
        assert!(!outcome.truncated);
    }

    #[test]
    fn expired_deadline_drops_the_coarse_diff() {
        let old = numbered(2000, "a");
        let new = numbered(2000, "b");
        let mut budget = OutputBudget::default();
        let outcome =
            super::diff_texts(old.as_bytes(), new.as_bytes(), Instant::now(), &mut budget);
        assert!(outcome.timed_out);
        assert!(!outcome.truncated);
        assert!(outcome.hunks.is_empty());
        assert_eq!((outcome.additions, outcome.deletions), (0, 0));
        assert_eq!(budget.lines, OutputBudget::default().lines);
    }

    #[test]
    fn output_budget_is_shared_and_counts_json_escaping_and_newline_markers() {
        let mut budget = OutputBudget {
            lines: 2,
            bytes: 1024,
        };
        let first = super::diff_texts(b"", b"a\n", far(), &mut budget);
        assert!(!first.truncated);
        let next = super::diff_texts(b"", b"b\nc\n", far(), &mut budget);
        assert!(next.truncated);
        assert_eq!(next.additions, 2);
        assert_eq!(next.hunks[0].lines, ["+b"]);
        assert_eq!(first.hunks[0].lines, ["+a"]);
        let mut budget = OutputBudget {
            lines: 10,
            bytes: 6,
        };
        let escaped = super::diff_texts(b"", b"\t\"\n", far(), &mut budget);
        assert!(escaped.truncated);
        assert!(escaped.hunks.is_empty());
        let no_newline = diff_texts_with_limit(b"", b"a", far(), 1);
        assert!(no_newline.truncated);
        assert!(no_newline.hunks.is_empty());
        let no_newline = diff_texts_with_limit(b"", b"a", far(), 2);
        assert!(!no_newline.truncated);
        assert_eq!(no_newline.hunks[0].lines, ["+a", NO_NEWLINE_MARKER]);
    }

    #[test]
    fn bare_carriage_return_is_content_and_missing_newline_is_a_change() {
        let outcome = diff_texts(b"a\r", b"a", far());
        assert_eq!((outcome.additions, outcome.deletions), (1, 1));
        assert_eq!(
            outcome.hunks[0].lines,
            ["-a\r", NO_NEWLINE_MARKER, "+a", NO_NEWLINE_MARKER]
        );
        let outcome = diff_texts(b"a\n", b"a", far());
        assert_eq!(outcome.hunks[0].lines, ["-a", "+a", NO_NEWLINE_MARKER]);
        let outcome = diff_texts(b"a", b"a\n", far());
        assert_eq!(outcome.hunks[0].lines, ["-a", NO_NEWLINE_MARKER, "+a"]);
    }

    #[test]
    fn many_medium_files_diff_quickly() {
        let files: Vec<(String, String)> = (0..40)
            .map(|file| {
                let old: String = (0..3000)
                    .map(|i| format!("    let value_{file}_{i} = compute({i}, \"{file}\");\n"))
                    .collect();
                let new: String = old
                    .lines()
                    .enumerate()
                    .map(|(i, line)| {
                        if i % 10 == 3 {
                            format!("{line} // changed\n")
                        } else {
                            format!("{line}\n")
                        }
                    })
                    .collect();
                (old, new)
            })
            .collect();
        let started = Instant::now();
        let mut changed = 0u32;
        let mut budget = OutputBudget::default();
        for (old, new) in &files {
            let outcome = super::diff_texts(old.as_bytes(), new.as_bytes(), far(), &mut budget);
            assert!(!outcome.truncated);
            changed += outcome.additions;
        }
        let elapsed = started.elapsed();
        eprintln!("review_diff perf: 40 files x 3000 lines (~10% changed) in {elapsed:?}");
        assert_eq!(changed, 40 * 300);
        assert!(elapsed < Duration::from_secs(3), "took {elapsed:?}");
    }

    #[test]
    fn matches_git_no_index_when_git_exists() {
        if which::which("git").is_err() {
            eprintln!("git not found; skipping parity test");
            return;
        }
        let dir = std::env::temp_dir().join(format!(
            "claudinal-review-diff-parity-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let control = crate::review_snapshot::Control::new(
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Duration::from_secs(10),
        );
        for (index, (name, old, new)) in fixtures().into_iter().enumerate() {
            let old_path = dir.join(format!("{index}-old.txt"));
            let new_path = dir.join(format!("{index}-new.txt"));
            // Normalize only the disposable fixture copies. The source
            // comparison must still retain final-newline differences.
            std::fs::write(&old_path, old.replace("\r\n", "\n")).unwrap();
            std::fs::write(&new_path, new.replace("\r\n", "\n")).unwrap();
            let raw = crate::review_snapshot::git_diff(&old_path, &new_path, &control).unwrap();
            let git = crate::commands::parse_git_patch(&raw).pop().unwrap();
            let ours = diff_texts(old.as_bytes(), new.as_bytes(), far());
            assert_eq!(
                (ours.additions, ours.deletions),
                (git.additions, git.deletions),
                "{name}"
            );
            let changed = |hunks: &[DiffHunk]| {
                let mut lines: Vec<String> = hunks
                    .iter()
                    .flat_map(|hunk| &hunk.lines)
                    .filter(|line| !line.starts_with(' '))
                    .cloned()
                    .collect();
                lines.sort();
                lines
            };
            assert_eq!(changed(&ours.hunks), changed(&git.hunks), "{name}");
            let headers = |hunks: &[DiffHunk]| {
                hunks
                    .iter()
                    .map(|h| (h.old_start, h.old_lines, h.new_start, h.new_lines))
                    .collect::<Vec<_>>()
            };
            assert_eq!(headers(&ours.hunks), headers(&git.hunks), "{name}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
