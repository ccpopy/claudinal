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

#[derive(Clone, Debug, Serialize)]
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
    pub mid_turn_input: Support,
    pub hook_events: Support,
    pub headless_model_command: Support,
    pub native_ultracode_effort: Support,
    pub fork_session: Support,
    pub checked_at: String,
    pub certification: &'static str,
}

pub fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    version.split_whitespace().find_map(|token| {
        let core = token.trim_start_matches('v').split(['-', '+']).next()?;
        let mut parts = core.split('.');
        let version = (
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
        );
        parts.next().is_none().then_some(version)
    })
}

pub fn version_at_least(version: &str, minimum: (u32, u32, u32)) -> Support {
    let Some(current) = parse_version(version) else {
        return Support::Unknown;
    };
    if current >= minimum {
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

pub fn mid_turn_input(version: &str) -> Support {
    // Streaming input predates this minimum. We need the result's complete input
    // UUID list to settle guides without completing a late guide from the next
    // turn. 2.1.259 added the list; 2.1.265 also covers no-API/deferred results.
    // See the SDK reference's user_message_uuid / user_message_uuids contract.
    // https://code.claude.com/docs/en/agent-sdk/typescript#user_message_uuid
    version_at_least(version, (2, 1, 265))
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
            (
                "userMessageReplay",
                "help or documented introduction: >=1.0.86",
            ),
            (
                "midTurnInput",
                "stream-json; complete result input UUID attribution: >=2.1.265",
            ),
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
        user_message_replay: if from_help("--replay-user-messages", help) == Support::Supported {
            Support::Supported
        } else {
            version_at_least(&version, (1, 0, 86))
        },
        mid_turn_input: mid_turn_input(&version),
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
    fn mid_turn_uses_result_attribution_minimum_not_a_version_allowlist() {
        for version in [
            "2.1.265",
            "2.1.282",
            "2.1.283 (Claude Code)",
            "2.1.284",
            "2.2.0",
            "3.0.0",
        ] {
            // --help is not a complete protocol capability inventory.
            let caps = detect(std::path::Path::new("claude"), version.into(), "");
            assert_eq!(caps.mid_turn_input, Support::Supported, "{version}");
            assert_eq!(caps.user_message_replay, Support::Supported, "{version}");
        }
        assert_eq!(mid_turn_input("2.1.264"), Support::Unsupported);
        assert_eq!(mid_turn_input("unknown"), Support::Unknown);
    }

    #[test]
    fn supported_version_formats_share_the_same_numeric_comparison() {
        for version in [
            "v2.1.284",
            "Claude Code 2.1.284",
            "2.1.284-beta.1",
            "2.1.284+build.2",
        ] {
            assert_eq!(version_at_least(version, (2, 1, 265)), Support::Supported);
        }
        for version in ["", "unknown", "2.1", "2.1.bad", "2.1.284.1"] {
            assert_eq!(version_at_least(version, (2, 1, 265)), Support::Unknown);
        }
    }
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
