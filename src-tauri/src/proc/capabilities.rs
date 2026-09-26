use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallation {
    pub path: String,
    pub version: Option<String>,
    pub runnable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallations {
    pub selected_path: Option<String>,
    pub environment_locked: bool,
    pub installations: Vec<CliInstallation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCapabilities {
    pub executable_path: String,
    pub resolved_version: String,
    pub install_kind: String,
    pub fingerprint: String,
    pub evidence: std::collections::BTreeMap<&'static str, &'static str>,
    pub interrupt: Support,
    pub subagent_text_forwarding: Support,
    pub core_stream: Support,
    pub user_message_replay: Support,
    pub hook_events: Support,
    pub headless_model_command: Support,
    pub native_ultracode_effort: Support,
    pub fork_session: Support,
    pub checked_at: String,
    pub certification: &'static str,
}

pub fn version_at_least(version: &str, minimum: (u32, u32, u32)) -> Support {
    let Some(token) = version
        .split_whitespace()
        .find(|token| token.chars().next().is_some_and(|c| c.is_ascii_digit()))
    else {
        return Support::Unknown;
    };
    let numbers: Vec<_> = token.split('.').map(str::parse::<u32>).collect();
    let [Ok(major), Ok(minor), Ok(patch)] = numbers.as_slice() else {
        return Support::Unknown;
    };
    if (*major, *minor, *patch) >= minimum {
        Support::Supported
    } else {
        Support::Unsupported
    }
}

pub fn from_help(flag: &str, help: &str) -> Support {
    if help
        .split_whitespace()
        .any(|token| token.trim_end_matches(',') == flag)
    {
        Support::Supported
    } else {
        Support::Unknown
    }
}

pub fn detect(path: &std::path::Path, version: String, help: &str) -> CliCapabilities {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hash);
    version.hash(&mut hash);
    if let Ok(meta) = std::fs::metadata(path) {
        meta.len().hash(&mut hash);
        meta.modified().ok().hash(&mut hash);
    }
    CliCapabilities {
        fingerprint: format!("{:016x}", hash.finish()),
        evidence: std::collections::BTreeMap::from([
            ("coreStream", "help; missing entries remain unknown"),
            ("userMessageReplay", "help"),
            ("hookEvents", "help"),
            (
                "forkSession",
                "help; requires both fork-session and resume-session-at",
            ),
            ("headlessModelCommand", "documented version rule: >=2.1.205"),
            (
                "nativeUltracodeEffort",
                "documented version rule: >=2.1.203",
            ),
            ("interrupt", "runtime confirmation pending"),
            ("subagentTextForwarding", "runtime confirmation pending"),
        ]),
        interrupt: Support::Unknown,
        subagent_text_forwarding: Support::Unknown,
        executable_path: path.display().to_string(),
        install_kind: if path
            .extension()
            .is_some_and(|ext| ext == "cmd" || ext == "ps1")
        {
            "npm"
        } else {
            "native"
        }
        .into(),
        core_stream: from_help("--input-format", help),
        user_message_replay: from_help("--replay-user-messages", help),
        hook_events: from_help("--include-hook-events", help),
        headless_model_command: version_at_least(&version, (2, 1, 205)),
        native_ultracode_effort: version_at_least(&version, (2, 1, 203)),
        fork_session: if from_help("--fork-session", help) == Support::Supported
            && from_help("--resume-session-at", help) == Support::Supported
        {
            Support::Supported
        } else {
            Support::Unknown
        },
        resolved_version: version,
        checked_at: chrono::Utc::now().to_rfc3339(),
        certification: "unverified; help and documented version rules only",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_help_is_unknown_and_versions_are_exact() {
        assert_eq!(
            from_help("--include-hook-events", "--help"),
            Support::Unknown
        );
        assert_eq!(from_help("--model", "--model-id"), Support::Unknown);
        assert_eq!(
            version_at_least("2.1.283 (Claude Code)", (2, 1, 203)),
            Support::Supported
        );
        assert_eq!(
            version_at_least("2.1.202", (2, 1, 203)),
            Support::Unsupported
        );
        assert_eq!(version_at_least("unknown", (2, 1, 203)), Support::Unknown);
    }
}
