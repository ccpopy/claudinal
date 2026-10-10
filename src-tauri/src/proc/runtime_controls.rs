//! Public native/SDK control contracts. Every exported reply is an allowlisted
//! projection; env, hooks, auth, provider URLs, and arbitrary settings stay private.
use super::capabilities::{version_at_least, CliCapabilities, Support};
use crate::error::{Error, Result};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

pub const CONTROL_MINIMUM: (u32, u32, u32) = (2, 1, 296);

pub fn supported(version: &str) -> Result<()> {
    if version_at_least(version, CONTROL_MINIMUM) == Support::Supported {
        Ok(())
    } else {
        Err(Error::Other(
            "当前 CLI 的会话控制契约尚未确认，请升级至 2.1.296 或更新版本".into(),
        ))
    }
}

#[cfg(test)]
pub fn validate_settings(settings: &Value, version: &str) -> Result<()> {
    let caps = super::capabilities::detect(std::path::Path::new("claude"), version.into(), "");
    validate_settings_for_capabilities(settings, &caps)
}

pub fn validate_settings_for_capabilities(settings: &Value, caps: &CliCapabilities) -> Result<()> {
    validate_settings_shape(settings)?;
    for (key, support) in [
        ("ultracode", caps.independent_ultracode),
        ("fastMode", caps.headless_fast_mode),
        ("enableWorkflows", caps.runtime_settings_control),
    ] {
        if settings.get(key).is_some() && support != Support::Supported {
            return Err(Error::Other(format!("{key} 的实际 CLI 控制契约尚未确认")));
        }
    }
    if let Some(models) = settings.get("modelSettings").and_then(Value::as_object) {
        require_minimum(&caps.resolved_version, (2, 1, 251), "per-model settings")?;
        for preferences in models.values() {
            if preferences.get("maxEffortLevel").is_some() {
                require_minimum(&caps.resolved_version, (2, 1, 267), "per-model effort cap")?;
            }
            if preferences.get("autoCompactWindow").is_some() {
                require_minimum(
                    &caps.resolved_version,
                    (2, 1, 288),
                    "per-model compact window",
                )?;
            }
        }
    }
    Ok(())
}

/// Shape checks are independent of version hints and precede every mutation.
pub fn validate_settings_shape(settings: &Value) -> Result<()> {
    let object = settings
        .as_object()
        .ok_or_else(|| Error::Other("session settings must be an object".into()))?;
    if object.len() > 8 {
        return Err(Error::Other("too many session settings".into()));
    }
    for (key, value) in object {
        match key.as_str() {
            "effortLevel" => {
                if !matches!(value.as_str(), Some("low" | "medium" | "high" | "xhigh")) {
                    return Err(Error::Other(
                        "max is session-only; persisted effort must be low/medium/high/xhigh"
                            .into(),
                    ));
                }
                if !object.get("ultracode").is_some_and(Value::is_boolean) {
                    return Err(Error::Other(
                        "effort update must include explicit ultracode state".into(),
                    ));
                }
            }
            "ultracode" => {
                if !value.is_boolean() {
                    return Err(Error::Other("ultracode must be boolean".into()));
                }
            }
            "fastMode" => {
                if !value.is_boolean() {
                    return Err(Error::Other("fastMode must be boolean".into()));
                }
            }
            "enableWorkflows" => {
                if !value.is_boolean() {
                    return Err(Error::Other("enableWorkflows must be boolean".into()));
                }
            }
            "modelSettings" => {
                let models = value
                    .as_object()
                    .ok_or_else(|| Error::Other("modelSettings must be an object".into()))?;
                if models.len() > 128 {
                    return Err(Error::Other("too many model settings".into()));
                }
                for (model, preferences) in models {
                    if model.trim().is_empty()
                        || model.len() > 256
                        || model.chars().any(char::is_control)
                    {
                        return Err(Error::Other("invalid canonical model key".into()));
                    }
                    let preferences = preferences.as_object().ok_or_else(|| {
                        Error::Other("model preferences must be an object".into())
                    })?;
                    for (key, value) in preferences {
                        match key.as_str() {
                            "effortLevel"
                                if matches!(
                                    value.as_str(),
                                    Some("low" | "medium" | "high" | "xhigh")
                                ) =>
                            {
                                if !object.get("ultracode").is_some_and(Value::is_boolean) {
                                    return Err(Error::Other(
                                        "model effort update must include explicit ultracode state"
                                            .into(),
                                    ));
                                }
                            }
                            "maxEffortLevel"
                                if matches!(
                                    value.as_str(),
                                    Some("low" | "medium" | "high" | "xhigh" | "max")
                                ) => {}
                            "autoCompactWindow"
                                if value.as_str() == Some("auto")
                                    || value
                                        .as_u64()
                                        .is_some_and(|n| (100_000..=1_000_000).contains(&n)) => {}
                            _ => {
                                return Err(Error::Other(format!(
                                    "unsupported model preference: {key}"
                                )))
                            }
                        }
                    }
                }
            }
            _ => return Err(Error::Other(format!("unsupported session setting: {key}"))),
        }
    }
    Ok(())
}

fn require_minimum(version: &str, minimum: (u32, u32, u32), feature: &str) -> Result<()> {
    if version_at_least(version, minimum) == Support::Supported {
        Ok(())
    } else {
        Err(Error::Other(format!(
            "{feature} is not confirmed for this CLI version"
        )))
    }
}

pub fn project_settings(settings: &Value) -> Value {
    let mut result = Map::new();
    for key in [
        "effortLevel",
        "ultracode",
        "fastMode",
        "fastModePerSessionOptIn",
        "enableWorkflows",
        "maxEffortLevel",
        "autoCompactWindow",
    ] {
        if let Some(value) = settings.get(key).filter(|v| setting_value(key, v, false)) {
            result.insert(key.into(), value.clone());
        }
    }
    if let Some(models) = settings.get("modelSettings").and_then(Value::as_object) {
        let filtered: Map<_, _> = models
            .iter()
            .take(128)
            .filter(|(model, _)| {
                !model.trim().is_empty()
                    && model.len() <= 256
                    && !model.chars().any(char::is_control)
            })
            .map(|(model, prefs)| {
                let values: Map<_, _> = ["effortLevel", "maxEffortLevel", "autoCompactWindow"]
                    .into_iter()
                    .filter_map(|key| {
                        prefs
                            .get(key)
                            .filter(|v| setting_value(key, v, true))
                            .map(|v| (key.into(), v.clone()))
                    })
                    .collect();
                (model.clone(), Value::Object(values))
            })
            .collect();
        result.insert("modelSettings".into(), Value::Object(filtered));
    }
    Value::Object(result)
}

fn setting_value(key: &str, value: &Value, per_model: bool) -> bool {
    match key {
        "effortLevel" => matches!(value.as_str(), Some("low" | "medium" | "high" | "xhigh")),
        "maxEffortLevel" => matches!(
            value.as_str(),
            Some("low" | "medium" | "high" | "xhigh" | "max")
        ),
        "autoCompactWindow" => {
            (per_model && value.as_str() == Some("auto"))
                || value
                    .as_u64()
                    .is_some_and(|n| (100_000..=1_000_000).contains(&n))
        }
        "ultracode" | "fastMode" | "fastModePerSessionOptIn" | "enableWorkflows" => {
            value.is_boolean()
        }
        _ => false,
    }
}

pub fn validate_settings_reply(raw: &Value) -> Result<()> {
    if !raw.get("effective").is_some_and(Value::is_object)
        || !raw.get("applied").is_some_and(Value::is_object)
        || !raw
            .pointer("/applied/model")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
        || !raw
            .pointer("/applied/effort")
            .and_then(Value::as_str)
            .is_some_and(|s| matches!(s, "low" | "medium" | "high" | "xhigh" | "max"))
    {
        return Err(Error::Other("CLI 设置响应无效，实际配置尚未确认".into()));
    }
    Ok(())
}

pub fn settings_reply(raw: &Value, activity: &Activity) -> Value {
    let mut applied = Map::new();
    for key in [
        "model",
        "effort",
        "ultracode",
        "ultracodeRequested",
        "ultracodeAvailable",
    ] {
        if let Some(value) = raw
            .get("applied")
            .and_then(|v| v.get(key))
            .filter(|v| match key {
                "model" => v.as_str().is_some_and(|s| {
                    !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
                }),
                "effort" => matches!(
                    v.as_str(),
                    Some("low" | "medium" | "high" | "xhigh" | "max")
                ),
                _ => v.is_boolean(),
            })
        {
            applied.insert(key.into(), value.clone());
        }
    }
    let sources: Vec<_> = raw
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(16)
        .filter_map(|entry| {
            let source = entry.get("source")?.as_str()?;
            if !matches!(
                source,
                "userSettings"
                    | "projectSettings"
                    | "localSettings"
                    | "flagSettings"
                    | "policySettings"
                    | "managedSettings"
            ) {
                return None;
            }
            Some(json!({"source":source,"settings":project_settings(&entry["settings"])}))
        })
        .collect();
    json!({"effective":project_settings(&raw["effective"]), "sources":sources, "applied":applied,
        "fastModeState":activity.fast_state, "fastModeDisabledReason":activity.fast_reason,
        "certification":"native metadata/control handling; account and model-request eligibility unverified"})
}

pub fn context_reply(raw: &Value) -> Value {
    let mut result = Map::new();
    for key in [
        "totalTokens",
        "maxTokens",
        "rawMaxTokens",
        "percentage",
        "autoCompactThreshold",
    ] {
        if let Some(value) = raw
            .get(key)
            .filter(|value| value.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
        {
            result.insert(key.into(), value.clone());
        }
    }
    if let Some(model) = raw.get("model").and_then(Value::as_str) {
        result.insert(
            "model".into(),
            json!(model.chars().take(256).collect::<String>()),
        );
    }
    if let Some(value) = raw
        .get("isAutoCompactEnabled")
        .filter(|value| value.is_boolean())
    {
        result.insert("isAutoCompactEnabled".into(), value.clone());
    }
    let categories: Vec<_> = raw
        .get("categories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(128)
        .filter_map(|category| {
            let kind = category.get("kind")?.as_str()?;
            if !matches!(kind, "used" | "free" | "buffer" | "deferred") {
                return None;
            }
            Some(
                json!({"name":category.get("name")?.as_str()?.chars().take(128).collect::<String>(),
                "kind":kind,"tokens":category.get("tokens")?.as_u64()?}),
            )
        })
        .collect();
    result.insert("categories".into(), json!(categories));
    result.insert("detail".into(), json!("summary"));
    result.insert(
        "source".into(),
        json!("CLI summary estimates; model/provider window not independently certified"),
    );
    Value::Object(result)
}

pub fn rewind_reply(raw: &Value) -> Result<Value> {
    let can_rewind = raw
        .get("canRewind")
        .and_then(Value::as_bool)
        .ok_or_else(|| Error::Other("invalid CLI rewind response".into()))?;
    let mut result = json!({"canRewind":can_rewind});
    if let Some(error) = raw.get("error").and_then(Value::as_str) {
        result["error"] = json!(error.chars().take(1024).collect::<String>());
    }
    for key in ["insertions", "deletions", "skippedLinks"] {
        if let Some(number) = raw.get(key).and_then(Value::as_u64) {
            result[key] = json!(number);
        }
    }
    for key in ["filesChanged"] {
        if let Some(files) = raw.get(key).and_then(Value::as_array) {
            if files.len() > 2000 {
                return Err(Error::Other("rewind preview exceeds file limit".into()));
            }
            let filtered: Vec<_> = files
                .iter()
                .map(|file| {
                    let path = file
                        .as_str()
                        .ok_or_else(|| Error::Other("invalid rewind preview file".into()))?;
                    if path.len() > 4096 || path.chars().any(char::is_control) {
                        return Err(Error::Other("invalid rewind preview path".into()));
                    }
                    Ok(path.to_string())
                })
                .collect::<Result<_>>()?;
            result[key] = json!(filtered);
        }
    }
    Ok(result)
}

pub struct Preview {
    pub id: String,
    pub message_id: String,
    pub epoch: u64,
    pub created: Instant,
    pub result: Value,
}
struct EndedTask {
    run: Option<String>,
    notification_seen: bool,
}
#[derive(Default)]
pub struct Activity {
    pub turn_active: bool,
    pub tasks: HashSet<String>,
    task_runs: HashMap<String, String>,
    // A membership replacement must not erase the identity needed to reject
    // late bookends. A per-process bounded history is enough to distinguish
    // a known ended run from a demonstrably newer run, without guessing success.
    ended_tasks: HashMap<String, EndedTask>,
    ended_task_order: VecDeque<String>,
    tasks_overflow: bool,
    pub permissions: HashSet<String>,
    pending_inputs: HashSet<String>,
    permissions_overflow: bool,
    pub epoch: u64,
    pub fast_state: Option<String>,
    pub fast_reason: Option<String>,
    pub preview: Option<Preview>,
}
impl Activity {
    pub fn idle(&self) -> bool {
        !self.turn_active
            && self.tasks.is_empty()
            && self.permissions.is_empty()
            && self.pending_inputs.is_empty()
            && !self.tasks_overflow
            && !self.permissions_overflow
    }
    pub fn begin_inputs(&mut self, ids: &[String]) -> Result<()> {
        if ids.len() > 1024
            || self.pending_inputs.len()
                + ids
                    .iter()
                    .filter(|id| !self.pending_inputs.contains(*id))
                    .count()
                > 1024
        {
            return Err(Error::Other(
                "运行实例尚未完成的输入过多，请等待完成或重启会话".into(),
            ));
        }
        self.pending_inputs.extend(ids.iter().cloned());
        self.turn_active = true;
        self.epoch = self.epoch.saturating_add(1);
        self.preview = None;
        Ok(())
    }
    pub fn observe(&mut self, value: &Value) {
        if value.get("parent_tool_use_id").is_none_or(Value::is_null)
            && matches!(
                value.get("type").and_then(Value::as_str),
                Some("result" | "system" | "notification")
            )
        {
            self.observe_fast(value);
        }
        match (
            value.get("type").and_then(Value::as_str),
            value.get("subtype").and_then(Value::as_str),
        ) {
            (Some("system"), Some("task_started")) => {
                if let Some(id) = value.get("task_id").and_then(Value::as_str) {
                    self.track_task(id, value.get("run_id").and_then(Value::as_str));
                }
            }
            (Some("system"), Some("task_notification")) => {
                if let Some(id) = value.get("task_id").and_then(Value::as_str) {
                    self.complete_task(id, value.get("run_id").and_then(Value::as_str));
                }
            }
            (Some("system"), Some("background_tasks_changed")) => {
                if let Some(tasks) = value.get("tasks").and_then(Value::as_array) {
                    let previous = std::mem::take(&mut self.tasks);
                    let previous_runs = std::mem::take(&mut self.task_runs);
                    self.tasks_overflow = false;
                    for task in tasks
                        .iter()
                        .filter(|task| task.get("ambient").and_then(Value::as_bool) != Some(true))
                    {
                        if let Some(id) = task.get("task_id").and_then(Value::as_str) {
                            // The level is authoritative even when a task returns
                            // to membership without a run ID. Membership is not
                            // permission to forget/regress an already known run.
                            let latest_run = [
                                previous_runs.get(id).map(String::as_str),
                                self.task_runs.get(id).map(String::as_str),
                                self.ended_tasks
                                    .get(id)
                                    .and_then(|ended| ended.run.as_deref()),
                                task.get("run_id").and_then(Value::as_str),
                            ]
                            .into_iter()
                            .flatten()
                            .max()
                            .map(str::to_string);
                            self.activate_task(id, latest_run.as_deref());
                        } else {
                            self.tasks_overflow = true;
                        }
                    }
                    for id in previous
                        .difference(&self.tasks)
                        .cloned()
                        .collect::<Vec<_>>()
                    {
                        self.remember_ended(&id, previous_runs.get(&id).map(String::as_str), false);
                    }
                }
            }
            (Some("user"), _) => {
                if let Some(result) = value.get("toolUseResult").and_then(Value::as_object) {
                    if result.get("status").and_then(Value::as_str) == Some("async_launched")
                        || result.get("isAsync").and_then(Value::as_bool) == Some(true)
                    {
                        if let Some(id) = result
                            .get("agentId")
                            .or_else(|| result.get("agent_id"))
                            .and_then(Value::as_str)
                        {
                            self.track_task(id, None);
                        } else {
                            self.tasks_overflow = true;
                        }
                    }
                }
            }
            (Some("result"), _) => {
                self.turn_active = false;
                if let Some(ids) = value.get("user_message_uuids") {
                    if let Some(ids) = ids.as_array().filter(|ids| {
                        !ids.is_empty()
                            && ids.len() <= 64
                            && ids.iter().all(|id| {
                                id.as_str()
                                    .is_some_and(|id| !id.is_empty() && id.len() <= 256)
                            })
                    }) {
                        for id in ids {
                            self.pending_inputs.remove(id.as_str().unwrap());
                        }
                    }
                } else if let Some(id) = value.get("user_message_uuid").and_then(Value::as_str) {
                    self.pending_inputs.remove(id);
                }
            }
            (Some("control_request"), _)
                if value.pointer("/request/subtype").and_then(Value::as_str)
                    == Some("can_use_tool") =>
            {
                if let Some(id) = value.get("request_id").and_then(Value::as_str) {
                    if id.len() <= 256 && self.permissions.len() < 1024 {
                        self.permissions.insert(id.into());
                    } else {
                        self.permissions_overflow = true;
                    }
                }
            }
            (Some("control_cancel_request"), _) => {
                if let Some(id) = value.get("request_id").and_then(Value::as_str) {
                    self.permissions.remove(id);
                }
            }
            _ => {}
        }
    }
    pub fn observe_fast(&mut self, value: &Value) {
        if let Some(state) = value
            .get("fast_mode_state")
            .and_then(Value::as_str)
            .filter(|s| matches!(*s, "off" | "on" | "cooldown"))
        {
            self.fast_state = Some(state.into());
            self.fast_reason = value
                .get("fast_mode_disabled_reason")
                .and_then(Value::as_str)
                .filter(|s| {
                    matches!(
                        *s,
                        "not_first_party"
                            | "model_not_allowed"
                            | "extra_usage_disabled"
                            | "network_error"
                            | "sdk_opt_in_required"
                            | "disabled_by_env"
                            | "pending"
                            | "free"
                            | "preference"
                            | "unknown"
                    )
                })
                .map(str::to_string);
        }
    }
    fn track_task(&mut self, id: &str, run: Option<&str>) {
        if self.ended_tasks.get(id).is_some_and(|ended| {
            // A missing run cannot prove that an absent task restarted. Native
            // run IDs order lexically; an explicit newer ID can resume activity.
            !matches!((ended.run.as_deref(), run), (Some(ended), Some(run)) if run > ended)
        }) {
            return;
        }
        if self
            .task_runs
            .get(id)
            .is_some_and(|current| run.is_some_and(|run| run < current.as_str()))
        {
            return;
        }
        self.activate_task(id, run);
    }
    fn activate_task(&mut self, id: &str, run: Option<&str>) {
        if id.is_empty()
            || id.len() > 256
            || run.is_some_and(|run| run.is_empty() || run.len() > 256)
            || (self.tasks.len() >= 1024 && !self.tasks.contains(id))
        {
            self.tasks_overflow = true;
            return;
        }
        if let Some(run) = run {
            self.task_runs.insert(id.into(), run.into());
        }
        self.preview = None;
        self.epoch = self.epoch.saturating_add(1);
        self.tasks.insert(id.into());
    }
    fn complete_task(&mut self, id: &str, run: Option<&str>) {
        if self
            .task_runs
            .get(id)
            .is_some_and(|current| run.map_or(true, |run| run < current.as_str()))
        {
            return;
        }
        if self
            .ended_tasks
            .get(id)
            .is_some_and(|ended| match (ended.run.as_deref(), run) {
                (Some(ended_run), Some(run)) if run < ended_run => true,
                (Some(ended_run), Some(run)) if run > ended_run => false,
                // An older producer supplied no terminal run identity, but a
                // later authoritative level can establish the active run. Its
                // exact completion must still schedule the new summary.
                (None, Some(run)) => {
                    ended.notification_seen
                        && !self.task_runs.get(id).is_some_and(|current| current == run)
                }
                _ => ended.notification_seen,
            })
        {
            return;
        }
        let run = run
            .map(str::to_string)
            .or_else(|| self.task_runs.get(id).cloned());
        self.tasks.remove(id);
        self.task_runs.remove(id);
        self.remember_ended(id, run.as_deref(), true);
        // The first terminal notification schedules a foreground summary; a
        // replay after its result must not restart that completed summary.
        self.turn_active = true;
    }
    fn remember_ended(&mut self, id: &str, run: Option<&str>, notification_seen: bool) {
        if id.is_empty()
            || id.len() > 256
            || run.is_some_and(|run| run.is_empty() || run.len() > 256)
        {
            self.tasks_overflow = true;
            return;
        }
        if let Some(ended) = self.ended_tasks.get_mut(id) {
            match (ended.run.as_deref(), run) {
                (Some(previous), Some(run)) if run < previous => return,
                (Some(previous), Some(run)) if run > previous => {
                    ended.run = Some(run.into());
                    ended.notification_seen = notification_seen;
                }
                (None, Some(run)) => {
                    ended.run = Some(run.into());
                    ended.notification_seen = notification_seen;
                }
                _ => ended.notification_seen |= notification_seen,
            }
            return;
        }
        if self.ended_tasks.len() >= 1024 {
            if let Some(oldest) = self.ended_task_order.pop_front() {
                self.ended_tasks.remove(&oldest);
            }
        }
        self.ended_tasks.insert(
            id.into(),
            EndedTask {
                run: run.map(str::to_string),
                notification_seen,
            },
        );
        self.ended_task_order.push_back(id.into());
    }
    pub fn preview_matches(&self, preview_id: &str, message_id: &str) -> bool {
        self.preview.as_ref().is_some_and(|p| {
            p.id == preview_id
                && p.message_id == message_id
                && p.epoch == self.epoch
                && p.created.elapsed() < Duration::from_secs(300)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorded_payload(id: &str) -> Value {
        super::super::control::recorded_native_reply(id)["response"]["response"].clone()
    }

    #[test]
    fn next_turn_guide_stays_busy_until_its_own_attributed_result() {
        let mut activity = Activity::default();
        activity.begin_inputs(&["a".into()]).unwrap();
        activity.begin_inputs(&["b".into()]).unwrap();
        activity
            .observe(&json!({"type":"result","user_message_uuid":"a","user_message_uuids":["a"]}));
        assert!(!activity.idle());
        assert!(activity.pending_inputs.contains("b"));
        activity.observe(
            &json!({"type":"result","user_message_uuid":"b","user_message_uuids":[false]}),
        );
        assert!(!activity.idle());
        activity.observe(&json!({"type":"result"}));
        assert!(!activity.idle());
        activity.observe(&json!({"type":"result","user_message_uuid":"b"}));
        assert!(activity.idle());
        activity.begin_inputs(&["c".into(), "d".into()]).unwrap();
        activity.observe(
            &json!({"type":"result","user_message_uuid":"d","user_message_uuids":["c","d"]}),
        );
        assert!(activity.idle());
        let ids: Vec<_> = (0..1024).map(|id| id.to_string()).collect();
        activity.begin_inputs(&ids).unwrap();
        assert!(activity.begin_inputs(&["overflow".into()]).is_err());
        assert_eq!(activity.pending_inputs.len(), 1024);
    }

    #[test]
    fn settings_projection_preserves_precedence_without_secret_fields() {
        assert!(validate_settings_reply(&recorded_payload("native-settings-noauth-4")).is_ok());
        assert!(validate_settings_reply(&json!({"effective":{},"applied":{}})).is_err());
        assert!(validate_settings_reply(
            &json!({"effective":false,"applied":{"model":"opus","effort":"medium"}})
        )
        .is_err());
        let raw = json!({"effective":{"effortLevel":"high","maxEffortLevel":"xhigh","ultracode":false,"fastMode":true,"autoCompactWindow":150000,
            "env":{"API_KEY":"secret"},"hooks":{"secret":"secret"},"modelSettings":{"claude-opus-5-5":{"effortLevel":"low","maxEffortLevel":"max","autoCompactWindow":"auto","apiKey":"secret"}}},
            "sources":[{"source":"flagSettings","settings":{"effortLevel":"low","env":{"secret":"secret"}}},{"source":"secret","settings":{"fastMode":true}}],
            "applied":{"model":"claude-opus-5-5","effort":"medium","ultracode":true,"advisor":"secret","apiKey":"secret"}});
        let projected = settings_reply(&raw, &Activity::default());
        assert!(!projected.to_string().contains("secret"));
        assert_eq!(projected["sources"][0]["settings"]["effortLevel"], "low");
        assert_eq!(projected["sources"].as_array().unwrap().len(), 1);
        assert_eq!(
            projected["effective"]["modelSettings"]["claude-opus-5-5"]["autoCompactWindow"],
            "auto"
        );
        assert_eq!(projected["applied"]["ultracode"], true);
        assert!(projected["fastModeState"].is_null());
        let invalid = project_settings(
            &json!({"effortLevel":true,"fastMode":"low","ultracode":"secret","modelSettings":{"x":{"effortLevel":999,"autoCompactWindow":"secret","maxEffortLevel":true}}}),
        );
        assert_eq!(invalid, json!({"modelSettings":{"x":{}}}));
    }

    #[test]
    fn settings_enforce_independent_ultra_and_documented_version_and_range_limits() {
        let version = "2.1.296";
        assert!(validate_settings(&json!({"effortLevel":"low","ultracode":true}), version).is_ok());
        assert!(validate_settings(&json!({"effortLevel":"low"}), version).is_err());
        assert!(
            validate_settings(&json!({"effortLevel":"max","ultracode":false}), version).is_err()
        );
        assert!(validate_settings(&json!({"ultracode":true}), "2.1.283").is_err());
        assert!(validate_settings(&json!({"ultracode":false,"modelSettings":{"claude-opus-5-5":{"effortLevel":"high","maxEffortLevel":"max","autoCompactWindow":"auto"}}}),version).is_ok());
        assert!(validate_settings(
            &json!({"modelSettings":{"opus":{"effortLevel":"high"}}}),
            version
        )
        .is_err());
        for window in [
            json!(99999),
            json!(1000001),
            json!(100000.5),
            json!("default"),
        ] {
            assert!(validate_settings(
                &json!({"modelSettings":{"x":{"autoCompactWindow":window}}}),
                version
            )
            .is_err());
        }
        for window in [json!(100000), json!(1000000), json!("auto")] {
            assert!(validate_settings(
                &json!({"modelSettings":{"x":{"autoCompactWindow":window}}}),
                version
            )
            .is_ok());
        }
        assert!(validate_settings(
            &json!({"modelSettings":{"x":{"autoCompactWindow":"auto"}}}),
            "2.1.287"
        )
        .is_err());
        assert!(validate_settings(
            &json!({"modelSettings":{"x":{"maxEffortLevel":"max"}}}),
            "2.1.266"
        )
        .is_err());
        assert!(validate_settings(&json!({"env":{"key":"value"}}), version).is_err());
    }

    #[test]
    fn actual_native_context_and_no_checkpoint_refusal_are_preserved_safely() {
        let context = recorded_payload("native-context-noauth-2");
        let projected = context_reply(&context);
        assert_eq!(projected["detail"], "summary");
        assert_eq!(projected["totalTokens"], context["totalTokens"]);
        assert!(!projected["categories"].as_array().unwrap().is_empty());
        for key in [
            "gridRows",
            "memoryFiles",
            "mcpTools",
            "agents",
            "apiUsage",
            "messageBreakdown",
        ] {
            assert!(projected.get(key).is_none());
        }
        let refusal = rewind_reply(&recorded_payload("native-metadata-noauth-4")).unwrap();
        assert_eq!(refusal["canRewind"], false);
        let actual =
            rewind_reply(&json!({"canRewind":true,"skippedLinks":2,"filesChanged":["a.rs"]}))
                .unwrap();
        assert_eq!(actual["skippedLinks"], 2);
        assert!(rewind_reply(&json!({"canRewind":true,"filesChanged":[false]})).is_err());
        assert!(
            rewind_reply(&json!({"canRewind":true,"filesChanged":["x".repeat(4097)]})).is_err()
        );
    }

    #[test]
    fn actual_fast_reports_distinguish_preference_off_on_and_cooldown() {
        let mut activity = Activity::default();
        activity.observe(&json!({"type":"system","subtype":"init","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}));
        assert_eq!(activity.fast_state.as_deref(), Some("off"));
        assert_eq!(activity.fast_reason.as_deref(), Some("sdk_opt_in_required"));
        activity.observe(&json!({"type":"result","fast_mode_state":"cooldown"}));
        assert_eq!(activity.fast_state.as_deref(), Some("cooldown"));
        assert!(activity.fast_reason.is_none());
        activity.observe(&json!({"type":"result","fast_mode_state":"on"}));
        assert_eq!(activity.fast_state.as_deref(), Some("on"));
        activity.observe(&json!({"type":"result","fast_mode_state":"invalid","fast_mode_disabled_reason":"secret"}));
        assert_eq!(activity.fast_state.as_deref(), Some("on"));
        activity.observe(&json!({"type":"notification","fast_mode_state":"off","fast_mode_disabled_reason":"extra_usage_disabled"}));
        assert_eq!(activity.fast_state.as_deref(), Some("off"));
        assert_eq!(
            activity.fast_reason.as_deref(),
            Some("extra_usage_disabled")
        );
        activity.observe(&json!({"type":"system","subtype":"init","parent_tool_use_id":"child","fast_mode_state":"on"}));
        assert_eq!(activity.fast_state.as_deref(), Some("off"));
        activity.observe_fast(&json!({"fast_mode_state":"on"}));
        assert_eq!(activity.fast_state.as_deref(), Some("on"));
        assert!(activity.fast_reason.is_none());
    }

    #[test]
    fn workflow_shape_and_projection_never_export_raw_settings() {
        assert!(validate_settings_shape(
            &json!({"enableWorkflows":true,"ultracode":true,"effortLevel":"low"})
        )
        .is_ok());
        assert!(validate_settings_shape(&json!({"enableWorkflows":false})).is_ok());
        assert!(validate_settings_shape(&json!({"enableWorkflows":"true"})).is_err());
        assert!(validate_settings_shape(
            &json!({"enableWorkflows":true,"env":{"SECRET":"hidden"}})
        )
        .is_err());
        assert_eq!(
            project_settings(
                &json!({"enableWorkflows":false,"env":{"SECRET":"hidden"},"hooks":{"secret":true}})
            ),
            json!({"enableWorkflows":false})
        );
    }

    #[test]
    fn async_completion_permission_cancel_and_stale_run_never_allow_early_mutation() {
        let mut activity = Activity::default();
        activity.turn_active = true;
        activity.observe(
            &json!({"type":"user","toolUseResult":{"status":"async_launched","agentId":"a"}}),
        );
        activity.observe(&json!({"type":"result","is_error":true}));
        assert!(!activity.idle());
        activity.observe(
            &json!({"type":"system","subtype":"task_started","task_id":"a","run_id":"02"}),
        );
        activity.observe(
            &json!({"type":"system","subtype":"task_notification","task_id":"a","run_id":"01"}),
        );
        assert!(activity.tasks.contains("a"));
        activity.observe(
            &json!({"type":"system","subtype":"task_notification","task_id":"a","run_id":"02"}),
        );
        assert!(!activity.idle());
        activity.observe(&json!({"type":"control_request","request_id":"p","request":{"subtype":"can_use_tool"}}));
        activity.observe(&json!({"type":"result"}));
        assert!(!activity.idle());
        activity.observe(&json!({"type":"control_cancel_request","request_id":"p"}));
        assert!(activity.idle());
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"watch","ambient":true}]}));
        assert!(activity.idle());
    }

    #[test]
    fn background_level_removal_survives_late_same_run_edges_and_foreground_result() {
        let mut activity = Activity::default();
        activity.begin_inputs(&["input".into()]).unwrap();
        activity.observe(
            &json!({"type":"user","toolUseResult":{"status":"async_launched","agentId":"child"}}),
        );
        activity.observe(
            &json!({"type":"system","subtype":"task_started","task_id":"child","run_id":"runA"}),
        );
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}));
        activity.observe(
            &json!({"type":"system","subtype":"task_started","task_id":"child","run_id":"runA"}),
        );
        activity.observe(&json!({"type":"result","user_message_uuid":"input"}));
        assert!(activity.idle());
        assert_eq!(activity.ended_tasks["child"].run.as_deref(), Some("runA"));
        activity.observe(
            &json!({"type":"user","toolUseResult":{"status":"async_launched","agentId":"child"}}),
        );
        assert!(activity.idle());
        activity.observe(
            &json!({"type":"system","subtype":"task_started","task_id":"child","run_id":"runB"}),
        );
        assert!(!activity.idle());
        activity.observe(&json!({"type":"system","subtype":"task_notification","task_id":"child","run_id":"runA"}));
        assert!(activity.tasks.contains("child"));
        activity.observe(&json!({"type":"system","subtype":"task_notification","task_id":"child","run_id":"runB"}));
        assert!(!activity.idle());
        activity.observe(&json!({"type":"result"}));
        assert!(activity.idle());
        activity.observe(&json!({"type":"system","subtype":"task_notification","task_id":"child","run_id":"runB"}));
        assert!(activity.idle());
    }

    #[test]
    fn authoritative_reappearance_and_unknown_identity_have_distinct_busy_rules() {
        let mut activity = Activity::default();
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"child","run_id":"02"}]}));
        assert!(!activity.idle());
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}));
        activity.observe(
            &json!({"type":"system","subtype":"task_started","task_id":"child","run_id":"01"}),
        );
        activity.observe(&json!({"type":"system","subtype":"task_started","task_id":"child"}));
        assert!(activity.idle());
        // A new level is direct activity evidence even for the same run.
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"child","run_id":"02"}]}));
        assert!(!activity.idle());
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}));
        activity.observe(&json!({"type":"system","subtype":"task_started","task_id":"unknown"}));
        assert!(!activity.idle());
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}));
        activity.observe(&json!({"type":"system","subtype":"task_started","task_id":"unknown","run_id":"unproven"}));
        assert!(activity.idle());
        // A terminal notification after removal still schedules its first summary.
        activity.observe(
            &json!({"type":"system","subtype":"task_notification","task_id":"child","run_id":"02"}),
        );
        assert!(!activity.idle());
        activity.observe(&json!({"type":"result"}));
        assert!(activity.idle());
        activity.begin_inputs(&["pending".into()]).unwrap();
        activity.observe(&json!({"type":"control_request","request_id":"permission","request":{"subtype":"can_use_tool"}}));
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}));
        activity.observe(&json!({"type":"result","user_message_uuid":"pending"}));
        assert!(!activity.idle());
        activity.observe(&json!({"type":"control_cancel_request","request_id":"permission"}));
        assert!(activity.idle());
        activity
            .observe(&json!({"type":"system","subtype":"task_notification","task_id":"legacy"}));
        activity.observe(&json!({"type":"result"}));
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"legacy","run_id":"known"}]}));
        activity.observe(&json!({"type":"system","subtype":"task_notification","task_id":"legacy","run_id":"known"}));
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}));
        assert!(!activity.idle());
        activity.observe(&json!({"type":"result"}));
        assert!(activity.idle());
    }

    #[test]
    fn sparse_or_older_level_identity_cannot_release_a_known_newer_live_run() {
        let mut activity = Activity::default();
        activity.observe(
            &json!({"type":"system","subtype":"task_started","task_id":"child","run_id":"02"}),
        );
        for level in [
            json!({"task_id":"child"}),
            json!({"task_id":"child","run_id":"01"}),
        ] {
            activity.observe(
                &json!({"type":"system","subtype":"background_tasks_changed","tasks":[level]}),
            );
            assert_eq!(activity.task_runs["child"], "02");
            activity.observe(&json!({"type":"system","subtype":"task_notification","task_id":"child","run_id":"01"}));
            activity.observe(&json!({"type":"result"}));
            assert!(activity.tasks.contains("child"));
            assert!(!activity.idle());
        }
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}));
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"child"}]}));
        assert_eq!(activity.task_runs["child"], "02");
        activity.observe(
            &json!({"type":"system","subtype":"task_notification","task_id":"child","run_id":"01"}),
        );
        activity.observe(&json!({"type":"result"}));
        assert!(!activity.idle());
        activity.observe(
            &json!({"type":"system","subtype":"task_notification","task_id":"child","run_id":"02"}),
        );
        assert!(!activity.idle());
        activity.observe(&json!({"type":"result"}));
        assert!(activity.idle());
    }

    #[test]
    fn ended_task_identity_history_is_bounded_without_restarting_known_recent_runs() {
        let mut activity = Activity::default();
        for n in 0..1025 {
            activity.observe(&json!({"type":"system","subtype":"task_started","task_id":n.to_string(),"run_id":"01"}));
            activity
                .observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}));
        }
        assert_eq!(activity.ended_tasks.len(), 1024);
        assert_eq!(activity.ended_task_order.len(), 1024);
        assert!(!activity.ended_tasks.contains_key("0"));
        activity.observe(
            &json!({"type":"system","subtype":"task_started","task_id":"1024","run_id":"01"}),
        );
        assert!(activity.idle());
        activity.observe(
            &json!({"type":"system","subtype":"task_started","task_id":"1024","run_id":"02"}),
        );
        assert!(!activity.idle());
    }

    #[test]
    fn activity_limits_are_conservative_and_preview_is_scoped_expiring_and_single_use() {
        let mut activity = Activity::default();
        activity.preview = Some(Preview {
            id: "p".into(),
            message_id: "m".into(),
            epoch: 0,
            created: Instant::now(),
            result: json!({"canRewind":true}),
        });
        assert!(activity.preview_matches("p", "m"));
        assert!(!activity.preview_matches("wrong", "m"));
        assert!(!activity.preview_matches("p", "wrong"));
        activity.epoch += 1;
        assert!(!activity.preview_matches("p", "m"));
        activity.epoch = 0;
        activity.preview.as_mut().unwrap().created = Instant::now() - Duration::from_secs(301);
        assert!(!activity.preview_matches("p", "m"));
        activity.preview.take();
        assert!(!activity.preview_matches("p", "m"));
        for n in 0..1025 {
            activity.observe(
                &json!({"type":"system","subtype":"task_started","task_id":n.to_string()}),
            );
        }
        assert_eq!(activity.tasks.len(), 1024);
        activity.tasks.clear();
        activity.observe(&json!({"type":"result"}));
        assert!(!activity.idle());
        activity.observe(&json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}));
        assert!(activity.idle());
    }
}
