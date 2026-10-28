use serde_json::{json, Map, Value};
use tokio::process::Command;

use crate::error::{Error, Result};

const CMD_REMOVAL_OPT_OUT: &str = "CLAUDE_CODE_DISABLE_POWERSHELL_CMD_RM_DENY";

pub fn cli_mode(mode: &str) -> &str {
    if mode == "fullAccess" {
        "bypassPermissions"
    } else {
        mode
    }
}

pub fn configure_settings(mode: Option<&str>, settings: &mut Map<String, Value>) -> Result<()> {
    // The launch option, not settings.env, owns this process-only override.
    if let Some(env) = settings.get_mut("env").and_then(Value::as_object_mut) {
        env.remove(CMD_REMOVAL_OPT_OUT);
    }
    if mode != Some("fullAccess") {
        return Ok(());
    }
    for (section, key) in [
        ("sandbox", "enabled"),
        ("permissions", "blockReadsOutsideWorkingDirectories"),
    ] {
        let target = settings
            .entry(section)
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| Error::Other(format!("{section} settings must be an object")))?;
        target.insert(key.into(), json!(false));
    }
    Ok(())
}

pub fn configure_env(command: &mut Command, mode: Option<&str>) {
    if mode == Some("fullAccess") {
        command.env(CMD_REMOVAL_OPT_OUT, "1");
    } else {
        // Do not inherit a full-access flag from the parent or an API profile.
        command.env_remove(CMD_REMOVAL_OPT_OUT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_access_maps_to_real_cli_mode_and_keeps_existing_modes() {
        assert_eq!(cli_mode("fullAccess"), "bypassPermissions");
        for mode in ["default", "acceptEdits", "plan", "bypassPermissions"] {
            assert_eq!(cli_mode(mode), mode);
        }
    }

    #[test]
    fn full_access_changes_only_its_runtime_settings_and_preserves_denies_and_hooks() {
        let original = json!({
            "sandbox": {"enabled": true, "network": {"deniedDomains": ["internal"]}},
            "permissions": {"blockReadsOutsideWorkingDirectories": true, "deny": ["Read(secrets)"]},
            "hooks": {"PreToolUse": []}, "model": "sonnet",
            "env": {"CUSTOM": "kept", (CMD_REMOVAL_OPT_OUT): "0"}
        });
        assert_eq!(original["env"][CMD_REMOVAL_OPT_OUT], "0");
        let mut full = original.as_object().unwrap().clone();
        configure_settings(Some("fullAccess"), &mut full).unwrap();
        assert_eq!(full["sandbox"]["enabled"], false);
        assert_eq!(full["sandbox"]["network"], original["sandbox"]["network"]);
        assert_eq!(
            full["permissions"]["blockReadsOutsideWorkingDirectories"],
            false
        );
        assert_eq!(full["permissions"]["deny"], original["permissions"]["deny"]);
        assert_eq!(full["hooks"], original["hooks"]);
        assert_eq!(full["model"], "sonnet");
        assert_eq!(full["env"]["CUSTOM"], "kept");
        assert!(full["env"].get(CMD_REMOVAL_OPT_OUT).is_none());
        for mode in [
            None,
            Some("default"),
            Some("acceptEdits"),
            Some("plan"),
            Some("bypassPermissions"),
        ] {
            let mut ordinary = original.as_object().unwrap().clone();
            configure_settings(mode, &mut ordinary).unwrap();
            assert_eq!(ordinary["sandbox"], original["sandbox"]);
            assert_eq!(ordinary["permissions"], original["permissions"]);
            let mut command = Command::new("claude");
            command.env(CMD_REMOVAL_OPT_OUT, "1");
            configure_env(&mut command, mode);
            assert!(command
                .as_std()
                .get_envs()
                .any(|(key, value)| key == CMD_REMOVAL_OPT_OUT && value.is_none()));
        }
        let mut command = Command::new("claude");
        configure_env(&mut command, Some("fullAccess"));
        assert!(command
            .as_std()
            .get_envs()
            .any(|(key, value)| key == CMD_REMOVAL_OPT_OUT
                && value == Some(std::ffi::OsStr::new("1"))));
    }

    #[test]
    fn malformed_full_access_settings_fail_before_spawn() {
        let mut settings = json!({"sandbox": true}).as_object().unwrap().clone();
        assert!(configure_settings(Some("fullAccess"), &mut settings).is_err());
    }
}
