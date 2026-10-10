use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

type Reply = std::result::Result<Value, String>;

/// One table per Session/process generation. Never route a response via the
/// currently selected frontend session or export a raw settings reply as an event.
#[derive(Default)]
pub struct ReplyWaiters(Mutex<HashMap<String, oneshot::Sender<Reply>>>);

impl ReplyWaiters {
    pub fn register(self: &Arc<Self>) -> std::result::Result<PendingReply, String> {
        let mut waiters = self.0.lock().map_err(|_| "control waiter lock poisoned")?;
        if waiters.len() >= 16 {
            return Err("too many pending CLI control requests".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        waiters.insert(id.clone(), tx);
        Ok(PendingReply {
            id,
            owner: self.clone(),
            rx: Some(rx),
        })
    }

    pub fn consume(&self, event: &Value) -> bool {
        let kind = event.get("type").and_then(Value::as_str);
        if kind == Some("control_cancel_request") {
            if let Some(id) = event.get("request_id").and_then(Value::as_str) {
                return self.settle(id, Err("CLI 已取消控制请求".into()));
            }
            return false;
        }
        if kind != Some("control_response") {
            return false;
        }
        if let Some(id) = event
            .pointer("/response/request_id")
            .and_then(Value::as_str)
        {
            let reply = match event.pointer("/response/subtype").and_then(Value::as_str) {
                Some("success") => Ok(event
                    .pointer("/response/response")
                    .cloned()
                    .unwrap_or_else(|| json!({}))),
                // Raw settings errors may echo env/auth values. Keep the error
                // envelope semantics without exporting its arbitrary payload.
                Some("error") => Err("CLI 拒绝控制请求；操作未确认成功".into()),
                _ => Err("CLI 返回无效的控制响应".into()),
            };
            self.settle(id, reply);
        }
        // Stale, duplicate, unrecognized-ID replies are discarded here too.
        true
    }

    fn settle(&self, id: &str, reply: Reply) -> bool {
        if let Ok(mut waiters) = self.0.lock() {
            if let Some(sender) = waiters.remove(id) {
                let _ = sender.send(reply);
                return true;
            }
        }
        false
    }

    pub fn close(&self, reason: &str) {
        if let Ok(mut waiters) = self.0.lock() {
            for (_, sender) in waiters.drain() {
                let _ = sender.send(Err(reason.into()));
            }
        }
    }
}

pub struct PendingReply {
    pub id: String,
    owner: Arc<ReplyWaiters>,
    rx: Option<oneshot::Receiver<Reply>>,
}
impl PendingReply {
    pub async fn receive(mut self, timeout: std::time::Duration) -> Reply {
        match tokio::time::timeout(timeout, self.rx.take().unwrap()).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("CLI 控制连接已结束".into()),
            Err(_) => Err("CLI 控制请求超时；结果未确认，未自动重试".into()),
        }
    }
}
impl Drop for PendingReply {
    fn drop(&mut self) {
        if let Ok(mut waiters) = self.owner.0.lock() {
            waiters.remove(&self.id);
        }
    }
}

/// The public SDK 0.3.296 SDKControlErrorResponse envelope is also used by the
/// stream-json transport. Reject extensions explicitly rather than granting
/// permission, inventing a subtype response, or terminating a healthy runtime.
pub fn unsupported_response(request: &Value) -> Option<Value> {
    let id = request.get("request_id")?.as_str()?;
    if id.is_empty() || id.len() > 256 {
        return None;
    }
    Some(json!({"type": "control_response", "response": {
        "subtype": "error", "request_id": id,
        "error": "Claudinal does not support this control request"
    }}))
}

#[derive(Default)]
pub struct ControlReceipts {
    ids: HashSet<String>,
    pending_permissions: HashSet<String>,
    cancelled_permissions: HashSet<String>,
    order: VecDeque<String>,
}
impl ControlReceipts {
    pub fn should_forward_permission(
        &mut self,
        event: &Value,
    ) -> std::result::Result<bool, String> {
        if event.get("type").and_then(Value::as_str) != Some("control_request")
            || event.pointer("/request/subtype").and_then(Value::as_str) != Some("can_use_tool")
        {
            return Ok(true);
        }
        let id = event
            .get("request_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
            .ok_or_else(|| "CLI 权限请求缺少有效 request_id，无法安全回复".to_string())?;
        if self.ids.contains(id) || self.pending_permissions.contains(id) {
            return Ok(false);
        }
        if self.pending_permissions.len() >= 1024 {
            return Err("CLI 未完成权限请求已达到上限".into());
        }
        self.pending_permissions.insert(id.into());
        Ok(true)
    }
    pub fn cancel_permission(&mut self, id: &str) {
        if !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control) {
            self.pending_permissions.remove(id);
            if self.insert(id) {
                self.cancelled_permissions.insert(id.into());
            }
        }
    }
    /// Called under the stdin write lock: cancellation received while waiting
    /// for a prior frame must invalidate this reply before it reaches the CLI.
    pub fn claim_permission_reply(&mut self, id: &str) -> std::result::Result<bool, String> {
        if self.cancelled_permissions.contains(id) {
            return Err("CLI 权限请求已取消，未发送授权回复".into());
        }
        if self.ids.contains(id) {
            return Ok(false);
        }
        if !self.pending_permissions.remove(id) {
            return Err("CLI 权限请求已结束或未知，未发送授权回复".into());
        }
        self.insert(id);
        Ok(true)
    }
    pub fn insert(&mut self, id: &str) -> bool {
        self.pending_permissions.remove(id);
        if !self.ids.insert(id.into()) {
            return false;
        }
        self.order.push_back(id.into());
        while self.order.len() > 512 {
            if let Some(oldest) = self.order.pop_front() {
                self.ids.remove(&oldest);
                self.cancelled_permissions.remove(&oldest);
            }
        }
        true
    }
}

// Exact non-secret native CLI 2.1.296 envelopes recorded on 2026-10-10 in
// isolated config with no model prompt, tools, hooks, MCP or authenticated account.
// Request types: apply_flag_settings, get_settings, unknown no-op, rewind_files
// dry_run:true, get_context_usage detail:summary. Full local research recordings
// retain provenance. Context omits unrelated grid/files/tools/account metadata.
#[cfg(test)]
pub(super) fn recorded_native_reply(id: &str) -> Value {
    let raw = match id {
        "native-settings-noauth-3" => {
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"native-settings-noauth-3"}}"#
        }
        "native-settings-noauth-4" => {
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"native-settings-noauth-4","response":{"effective":{"hooks":{},"effortLevel":"low","ultracode":false,"fastMode":false},"sources":[{"source":"flagSettings","settings":{"hooks":{},"effortLevel":"low","ultracode":false,"fastMode":false}}],"applied":{"model":"claude-opus-5-5","effort":"low","advisor":null,"ultracode":false,"ultracodeRequested":false,"ultracodeAvailable":true}}}}"#
        }
        "native-metadata-noauth-2" => {
            r#"{"type":"control_response","response":{"subtype":"error","request_id":"native-metadata-noauth-2","error":"Unsupported control request subtype: fixture_unknown_noop"}}"#
        }
        "native-metadata-noauth-4" => {
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"native-metadata-noauth-4","response":{"canRewind":false,"error":"No file checkpoint found for this message."}}}"#
        }
        "native-context-noauth-2" => {
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"native-context-noauth-2","response":{"categories":[{"name":"System prompt","tokens":1849,"color":"promptBorder","kind":"used"},{"name":"Autocompact buffer","tokens":33000,"color":"inactive","kind":"buffer"},{"name":"Free space","tokens":965151,"color":"promptBorder","kind":"free"}],"totalTokens":1849,"maxTokens":1000000,"rawMaxTokens":1000000,"percentage":0,"model":"claude-opus-5-5","autoCompactThreshold":967000,"isAutoCompactEnabled":true}}}"#
        }
        _ => panic!("unknown native fixture"),
    };
    serde_json::from_str(raw).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn recorded_reply(id: &str) -> Value {
        recorded_native_reply(id)
    }

    #[tokio::test]
    async fn real_empty_ack_and_recorded_settings_are_scoped_and_deduplicated() {
        let first = Arc::new(ReplyWaiters::default());
        let second = Arc::new(ReplyWaiters::default());
        let pending = first.register().unwrap();
        let isolated = second.register().unwrap();
        let mut reply = recorded_reply("native-settings-noauth-3");
        reply["response"]["request_id"] = json!(pending.id);
        assert!(second.consume(&reply));
        assert_eq!(second.0.lock().unwrap().len(), 1);
        assert!(first.consume(&reply));
        assert!(first.consume(&reply));
        assert_eq!(
            pending.receive(Duration::from_secs(1)).await.unwrap(),
            json!({})
        );
        let pending = first.register().unwrap();
        let mut reply = recorded_reply("native-settings-noauth-4");
        reply["response"]["request_id"] = json!(pending.id);
        first.consume(&reply);
        assert_eq!(
            pending.receive(Duration::from_secs(1)).await.unwrap()["applied"]["effort"],
            "low"
        );
        drop(isolated);
    }

    #[tokio::test]
    async fn control_refusal_cancellation_exit_and_timeout_never_retry() {
        let replies = Arc::new(ReplyWaiters::default());
        let native = replies.register().unwrap();
        let mut native_refusal = recorded_reply("native-metadata-noauth-2");
        native_refusal["response"]["request_id"] = json!(native.id);
        assert!(replies.consume(&native_refusal));
        assert!(native.receive(Duration::from_secs(1)).await.is_err());
        let pending = replies.register().unwrap();
        replies.consume(&json!({"type":"control_response","response":{"subtype":"error","request_id":pending.id,"error":"secret-value"}}));
        let error = pending.receive(Duration::from_secs(1)).await.unwrap_err();
        assert!(!error.contains("secret-value"));
        let pending = replies.register().unwrap();
        assert!(replies.consume(&json!({"type":"control_cancel_request","request_id":pending.id})));
        assert!(pending
            .receive(Duration::from_secs(1))
            .await
            .unwrap_err()
            .contains("取消"));
        assert!(!replies
            .consume(&json!({"type":"control_cancel_request","request_id":"CLI-permission"})));
        let pending = replies.register().unwrap();
        replies.close("process exited");
        assert_eq!(
            pending.receive(Duration::from_secs(1)).await.unwrap_err(),
            "process exited"
        );
        let pending = replies.register().unwrap();
        assert!(pending
            .receive(Duration::from_millis(1))
            .await
            .unwrap_err()
            .contains("未自动重试"));
        assert!(replies.0.lock().unwrap().is_empty());
    }

    #[test]
    fn pending_limit_and_abandoned_future_release_slots() {
        let replies = Arc::new(ReplyWaiters::default());
        let mut pending: Vec<_> = (0..16).map(|_| replies.register().unwrap()).collect();
        assert!(replies.register().is_err());
        pending.pop();
        assert!(replies.register().is_ok());
        drop(pending);
        assert!(replies.0.lock().unwrap().is_empty());
        assert!(!replies.consume(&json!({"type":"system","subtype":"init"})));
        assert!(
            replies.consume(&json!({"type":"control_response","response":{"subtype":"unknown"}}))
        );
    }

    #[test]
    fn answered_permission_duplicates_do_not_reopen_backend_busy_state() {
        let mut receipts = ControlReceipts::default();
        let mut activity = super::super::runtime_controls::Activity::default();
        let request =
            json!({"type":"control_request","request_id":"p","request":{"subtype":"can_use_tool"}});
        assert!(receipts.should_forward_permission(&request).unwrap());
        activity.observe(&request);
        assert!(!activity.idle());
        assert!(receipts.insert("p"));
        activity.permissions.remove("p");
        if receipts.should_forward_permission(&request).unwrap() {
            activity.observe(&request);
        }
        assert!(activity.idle());
        for id in [
            json!(""),
            json!(null),
            json!("x".repeat(257)),
            json!("bad\n"),
        ] {
            let mut malformed = request.clone();
            malformed["request_id"] = id;
            assert!(receipts.should_forward_permission(&malformed).is_err());
        }
    }
    #[test]
    fn cancelled_permission_replay_does_not_reopen_backend_busy_state() {
        let mut receipts = ControlReceipts::default();
        let mut activity = super::super::runtime_controls::Activity::default();
        let request = json!({"type":"control_request","request_id":"cancelled","request":{"subtype":"can_use_tool"}});
        if receipts.should_forward_permission(&request).unwrap() {
            activity.observe(&request);
        }
        receipts.cancel_permission("cancelled");
        activity.observe(&json!({"type":"control_cancel_request","request_id":"cancelled"}));
        assert!(activity.idle());
        if receipts.should_forward_permission(&request).unwrap() {
            activity.observe(&request);
        }
        assert!(
            activity.idle(),
            "cancelled permission replay must stay settled"
        );
    }
    #[test]
    fn only_pending_permission_can_be_answered_and_other_runtimes_remain_isolated() {
        let mut first = ControlReceipts::default();
        let mut second = ControlReceipts::default();
        let request = json!({"type":"control_request","request_id":"same","request":{"subtype":"can_use_tool"}});
        assert!(first.claim_permission_reply("unknown").is_err());
        assert!(first.should_forward_permission(&request).unwrap());
        assert!(!first.should_forward_permission(&request).unwrap());
        assert!(second.should_forward_permission(&request).unwrap());
        first.cancel_permission("same");
        assert!(first.claim_permission_reply("same").is_err());
        assert!(second.claim_permission_reply("same").unwrap());
        assert!(!second.claim_permission_reply("same").unwrap());
        assert!(!second.should_forward_permission(&request).unwrap());
    }
    #[tokio::test]
    async fn cancellation_while_reply_waits_for_writer_revokes_the_reply() {
        use tokio::sync::Mutex;
        let receipts = Arc::new(Mutex::new(ControlReceipts::default()));
        let request = json!({"type":"control_request","request_id":"waiting","request":{"subtype":"can_use_tool"}});
        assert!(receipts
            .lock()
            .await
            .should_forward_permission(&request)
            .unwrap());
        let writer = Arc::new(Mutex::new(()));
        let held = writer.lock().await;
        let pending = tokio::spawn({
            let receipts = receipts.clone();
            let writer = writer.clone();
            async move {
                let _write_guard = writer.lock().await;
                receipts.lock().await.claim_permission_reply("waiting")
            }
        });
        tokio::task::yield_now().await;
        receipts.lock().await.cancel_permission("waiting");
        drop(held);
        assert!(pending.await.unwrap().is_err());
    }
    #[test]
    fn extension_response_uses_error_envelope_without_permissions() {
        let response =
            unsupported_response(&json!({"request_id":"r1", "request":{"subtype":"future"}}))
                .unwrap();
        assert_eq!(response["response"]["subtype"], "error");
        assert_eq!(response["response"]["request_id"], "r1");
        assert!(response["response"].get("response").is_none());
        assert!(unsupported_response(&json!({"request_id":""})).is_none());
        assert!(unsupported_response(&json!({})).is_none());
    }
    #[test]
    fn repeated_response_is_idempotent_and_receipts_are_bounded() {
        let mut receipts = ControlReceipts::default();
        assert!(receipts.insert("same"));
        assert!(!receipts.insert("same"));
        for id in 0..1000 {
            receipts.insert(&id.to_string());
        }
        assert_eq!(receipts.ids.len(), 512);
        assert!(!receipts.insert("999"));
    }
}
