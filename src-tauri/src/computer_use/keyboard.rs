//! Bounded key descriptions shared by the gateway and native executors.
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

#[derive(Clone, Debug)]
pub(super) struct Chord {
    pub key: String,
    pub modifiers: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum EditCommand {
    SelectAll,
    Undo,
    Redo,
}

impl Chord {
    pub fn parse(key: &str, modifiers: &[String]) -> Result<Self> {
        let lower = key.to_ascii_lowercase();
        let key = canonical_key(&lower).to_string();
        if key_code(&key).is_none() || modifiers.len() > 3 {
            return Err(Error::Other("Unsupported key or modifier count.".into()));
        }
        let mut seen = Vec::new();
        for modifier in modifiers {
            if !["ctrl", "shift", "alt"].contains(&modifier.as_str()) || seen.contains(modifier) {
                return Err(Error::Other(
                    "Use distinct ctrl, shift or alt modifiers.".into(),
                ));
            }
            seen.push(modifier.clone());
        }
        let has = |modifier: &str| modifiers.iter().any(|value| value == modifier);
        if has("alt") && ["tab", "escape", "f4", "space"].contains(&key.as_str())
            || has("ctrl") && key == "escape"
            || has("ctrl") && has("alt") && key == "delete"
        {
            return Err(Error::Other(
                "System window-switching and secure-desktop shortcuts are blocked.".into(),
            ));
        }
        let modifiers = ["ctrl", "shift", "alt"]
            .into_iter()
            .filter(|modifier| has(modifier))
            .map(str::to_string)
            .collect();
        Ok(Self { key, modifiers })
    }

    pub fn virtual_keys(&self) -> Vec<u16> {
        self.modifiers
            .iter()
            .map(|modifier| match modifier.as_str() {
                "ctrl" => 0x11,
                "shift" => 0x10,
                "alt" => 0x12,
                _ => unreachable!(),
            })
            .chain(std::iter::once(key_code(&self.key).unwrap()))
            .collect()
    }

    pub fn background_command(&self) -> Result<EditCommand> {
        let modifiers = self
            .modifiers
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        match (self.key.as_str(), modifiers.as_slice()) {
            ("a", ["ctrl"]) => Ok(EditCommand::SelectAll),
            ("z", ["ctrl"]) => Ok(EditCommand::Undo),
            ("y", ["ctrl"]) | ("z", ["ctrl", "shift"]) => Ok(EditCommand::Redo),
            _ => Err(Error::Other("This shortcut is unavailable in background mode. Enable Foreground shortcuts in Settings > Computer use for general shortcuts; no plain key was sent.".into())),
        }
    }
}

pub(super) fn canonical_key(key: &str) -> &str {
    match key {
        "enter" => "return",
        "esc" => "escape",
        "del" => "delete",
        "ins" => "insert",
        "pgup" => "pageup",
        "pgdn" => "pagedown",
        "arrowup" => "up",
        "arrowdown" => "down",
        "arrowleft" => "left",
        "arrowright" => "right",
        _ => key,
    }
}

pub(super) fn key_code(key: &str) -> Option<u16> {
    Some(match key {
        "return" => 0x0D,
        "tab" => 0x09,
        "escape" => 0x1B,
        "space" => 0x20,
        "backspace" => 0x08,
        "insert" => 0x2D,
        "delete" => 0x2E,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        _ if key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric() => {
            key.as_bytes()[0].to_ascii_uppercase() as u16
        }
        _ => {
            let number = key.strip_prefix('f')?.parse::<u16>().ok()?;
            if !(1..=12).contains(&number) {
                return None;
            }
            0x70 + number - 1
        }
    })
}

/// All downs and reverse-order ups are passed to SendInput in one bounded batch.
pub(super) fn input_sequence(keys: &[u16]) -> Vec<(u16, bool)> {
    keys.iter()
        .map(|key| (*key, false))
        .chain(keys.iter().rev().map(|key| (*key, true)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_shortcuts_are_semantic_and_never_plain_letters() {
        for (key, modifiers, command) in [
            ("A", vec!["ctrl"], EditCommand::SelectAll),
            ("z", vec!["ctrl"], EditCommand::Undo),
            ("y", vec!["ctrl"], EditCommand::Redo),
            ("z", vec!["shift", "ctrl"], EditCommand::Redo),
        ] {
            let chord = Chord::parse(
                key,
                &modifiers
                    .iter()
                    .map(|value| value.to_string())
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            assert_eq!(chord.background_command().unwrap(), command);
        }
        assert!(Chord::parse("c", &["ctrl".into()])
            .unwrap()
            .background_command()
            .is_err());
    }

    #[test]
    fn foreground_chords_release_every_key_and_reject_system_shortcuts() {
        let chord = Chord::parse("a", &["ctrl".into(), "shift".into()]).unwrap();
        assert_eq!(
            input_sequence(&chord.virtual_keys()),
            vec![
                (0x11, false),
                (0x10, false),
                (0x41, false),
                (0x41, true),
                (0x10, true),
                (0x11, true)
            ]
        );
        for (key, modifiers) in [
            ("tab", vec!["alt"]),
            ("f4", vec!["alt"]),
            ("escape", vec!["ctrl", "shift"]),
            ("delete", vec!["ctrl", "alt"]),
        ] {
            assert!(Chord::parse(
                key,
                &modifiers
                    .iter()
                    .map(|value| value.to_string())
                    .collect::<Vec<_>>()
            )
            .is_err());
        }
        assert!(Chord::parse("a", &["ctrl".into(), "ctrl".into()]).is_err());
        assert!(Chord::parse("a", &["win".into()]).is_err());
    }
}
