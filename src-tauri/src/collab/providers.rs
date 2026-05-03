use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::child_process::hide_tokio_window;
use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabProviderStatus {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub help_ok: bool,
    pub detected_flags: Vec<String>,
    pub missing_flags: Vec<String>,
    pub docs_url: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPathOverride {
    pub provider: String,
    pub path: String,
}

#[derive(Clone)]
pub struct ProviderSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub executable: &'static str,
    pub help_args: &'static [&'static str],
    pub version_args: &'static [&'static str],
    pub required_flags: &'static [&'static str],
    pub docs_url: &'static str,
}

pub fn provider_specs() -> Vec<ProviderSpec> {
    vec![
        ProviderSpec {
            id: "claude",
            label: "Claude Code",
            executable: "claude",
            help_args: &["--help"],
            version_args: &["--version"],
            required_flags: &[
                "--mcp-config",
                "--input-format",
                "--output-format",
                "--permission-mode",
            ],
            docs_url: "https://code.claude.com/docs/en/cli-reference",
        },
        ProviderSpec {
            id: "codex",
            label: "Codex",
            executable: "codex",
            help_args: &["exec", "--help"],
            version_args: &["--version"],
            required_flags: &[
                "--json",
                "--cd",
                "--sandbox",
                "--output-last-message",
                "--output-schema",
                "--skip-git-repo-check",
            ],
            docs_url: "https://developers.openai.com/codex/noninteractive",
        },
        ProviderSpec {
            id: "gemini",
            label: "Gemini CLI",
            executable: "gemini",
            help_args: &["--help"],
            version_args: &["--version"],
            required_flags: &["--output-format", "stream-json", "--approval-mode"],
            docs_url: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md",
        },
        ProviderSpec {
            id: "opencode",
            label: "opencode",
            executable: "opencode",
            help_args: &["run", "--help"],
            version_args: &["--version"],
            required_flags: &["run", "--format", "--session", "--continue"],
            docs_url: "https://opencode.ai/docs/cli/",
        },
    ]
}

pub async fn detect_providers(
    overrides: Option<Vec<ProviderPathOverride>>,
) -> Result<Vec<CollabProviderStatus>> {
    let overrides = override_map(overrides);
    let mut out = Vec::new();
    for spec in provider_specs() {
        out.push(detect_provider(&spec, &overrides).await);
    }
    Ok(out)
}

pub async fn detect_provider_by_id(
    provider: String,
    overrides: Option<Vec<ProviderPathOverride>>,
) -> Result<CollabProviderStatus> {
    let overrides = override_map(overrides);
    let spec = provider_specs()
        .into_iter()
        .find(|spec| spec.id == provider)
        .ok_or_else(|| crate::error::Error::Other(format!("unknown provider: {provider}")))?;
    Ok(detect_provider(&spec, &overrides).await)
}

pub fn executable_for_provider(provider: &str) -> Option<PathBuf> {
    let overrides = provider_path_overrides_from_env();
    let spec = provider_specs()
        .into_iter()
        .find(|spec| spec.id == provider)?;
    resolve_executable(&spec, &overrides)
}

pub fn provider_path_overrides_from_env() -> HashMap<String, PathBuf> {
    let raw = match std::env::var("CLAUDINAL_COLLAB_PROVIDER_PATHS") {
        Ok(raw) => raw,
        Err(_) => return HashMap::new(),
    };
    let parsed = serde_json::from_str::<HashMap<String, String>>(&raw).unwrap_or_default();
    parsed
        .into_iter()
        .filter(|(_, path)| !path.trim().is_empty())
        .map(|(provider, path)| (provider, PathBuf::from(path)))
        .collect()
}

async fn detect_provider(
    spec: &ProviderSpec,
    overrides: &HashMap<String, PathBuf>,
) -> CollabProviderStatus {
    let Some(path) = resolve_executable(spec, overrides) else {
        return CollabProviderStatus {
            id: spec.id.into(),
            label: spec.label.into(),
            installed: false,
            path: None,
            version: None,
            help_ok: false,
            detected_flags: vec![],
            missing_flags: spec
                .required_flags
                .iter()
                .map(|flag| (*flag).into())
                .collect(),
            docs_url: spec.docs_url.into(),
            message: format!("未找到 {} CLI", spec.executable),
        };
    };

    let help = run_capture(&path, spec.help_args).await;
    let version = run_capture(&path, spec.version_args)
        .await
        .ok()
        .and_then(|text| {
            text.lines()
                .next()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
        });

    match help {
        Ok(help) => {
            let detected_flags = spec
                .required_flags
                .iter()
                .filter(|flag| help.contains(*flag))
                .map(|flag| (*flag).to_string())
                .collect::<Vec<_>>();
            let missing_flags = spec
                .required_flags
                .iter()
                .filter(|flag| !help.contains(*flag))
                .map(|flag| (*flag).to_string())
                .collect::<Vec<_>>();
            let help_ok = missing_flags.is_empty();
            CollabProviderStatus {
                id: spec.id.into(),
                label: spec.label.into(),
                installed: true,
                path: Some(path.display().to_string()),
                version,
                help_ok,
                detected_flags,
                missing_flags: missing_flags.clone(),
                docs_url: spec.docs_url.into(),
                message: if help_ok {
                    "本机 help 与首版协同所需参数匹配".into()
                } else {
                    format!("本机 help 缺少参数：{}", missing_flags.join(", "))
                },
            }
        }
        Err(err) => CollabProviderStatus {
            id: spec.id.into(),
            label: spec.label.into(),
            installed: true,
            path: Some(path.display().to_string()),
            version,
            help_ok: false,
            detected_flags: vec![],
            missing_flags: spec
                .required_flags
                .iter()
                .map(|flag| (*flag).into())
                .collect(),
            docs_url: spec.docs_url.into(),
            message: format!("读取 help 失败：{err}"),
        },
    }
}

fn override_map(overrides: Option<Vec<ProviderPathOverride>>) -> HashMap<String, PathBuf> {
    overrides
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| !entry.provider.trim().is_empty() && !entry.path.trim().is_empty())
        .map(|entry| (entry.provider, PathBuf::from(entry.path)))
        .collect()
}

fn resolve_executable(
    spec: &ProviderSpec,
    overrides: &HashMap<String, PathBuf>,
) -> Option<PathBuf> {
    if let Some(path) = overrides.get(spec.id).filter(|path| path.is_file()) {
        return Some(path.clone());
    }
    which::which(spec.executable).ok()
}

async fn run_capture(path: &PathBuf, args: &[&str]) -> std::result::Result<String, String> {
    let mut cmd = Command::new(path);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    hide_tokio_window(&mut cmd);
    let output = cmd.output().await.map_err(|err| err.to_string())?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.stderr.is_empty() {
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    if output.status.success() {
        Ok(text)
    } else {
        Err(format!(
            "exit {}: {}",
            output
                .status
                .code()
                .map_or_else(|| "unknown".to_string(), |code| code.to_string()),
            text.trim()
        ))
    }
}
