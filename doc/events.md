# stream-json 事件 schema 参考

> 来源：`claude -p --input-format stream-json --output-format stream-json --include-partial-messages --include-hook-events --verbose`，CLI 2.1.123。
> 真实样本：[`doc/stream-json-1.txt`](./stream-json-1.txt)（一次普通对话，含 system/init、stream_event 全套、assistant 快照、result、rate_limit_event）。

未来遇到新事件场景（`permission_request` / `hook_event` / subagent 嵌套 / 长 tool_result / 错误路径）应当追加新样本到 `doc/`，并把表格里出现的字段补全。

---

## 1. 顶层事件类型

| `type` | 必有字段 | 说明 |
|---|---|---|
| `system` | `subtype`, `session_id`, `uuid` | 会话级元数据 |
| `stream_event` | `event`, `parent_tool_use_id`, `session_id`, `uuid` | partial 流（仅 `--include-partial-messages`） |
| `assistant` | `message`, `parent_tool_use_id`, `session_id`, `uuid` | 完整 assistant 消息快照 |
| `user` | `message`, `parent_tool_use_id`, `session_id`, `uuid` | 完整 user 消息（含工具回写） |
| `result` | `subtype`, `total_cost_usd`, `duration_ms`, `usage`, `uuid` | 一轮 user→assistant 完成时发送 |
| `rate_limit_event` | `rate_limit_info`, `session_id`, `uuid` | 速率限制状态 |
| `hook_event` | （未样本化） | 仅 `--include-hook-events` |

**未知 `type` 必须保留** —— 落到 `UIUnknown` 卡（见 `src/types/ui.ts`）。

---

## 2. system

### 2.1 `subtype: "init"`
启动后第一条事件。关键字段：

| 字段 | 类型 | 用途 |
|---|---|---|
| `session_id` | string | 当前会话 id |
| `model` | string | 例 `claude-opus-4-7[1m]` |
| `cwd` | string | 工作目录（绝对路径） |
| `permissionMode` | string | `default` / `acceptEdits` / `plan` / `bypassPermissions` |
| `mcp_servers` | `[{name, status}]` | status: `connected` / `needs-auth` / `failed` / 等 |
| `tools` | string[] | 当前会话可用工具 |
| `skills` | string[] | 已安装 skills |
| `slash_commands` | string[] | 可用斜杠命令（不含前缀 `/`） |
| `agents` | string[] | 可用 subagent |
| `plugins` | object[] | `[{name, path, source}]` |
| `output_style` | string | `default` / 自定义 |
| `apiKeySource` | string | `none` / `env` / `oauth` / 等 |
| `claude_code_version` | string | CLI 版本 |
| `fast_mode_state` | string | `on` / `off` |
| `memory_paths` | object | `{auto: <path>}` |
| `analytics_disabled` | bool | |

### 2.2 `subtype: "status"`
轻量状态变化：`{status: "requesting" | ...}`。

### 2.3 其他 subtype
未知 subtype 应保留并在 UI 上显示原 JSON。

---

## 3. stream_event（partial 流）

外层包装：
```json
{
  "type": "stream_event",
  "event": { ... },
  "parent_tool_use_id": null | "<id>",
  "session_id": "...",
  "uuid": "...",
  "ttft_ms": 2792
}
```

`event.type` 是 Anthropic Messages streaming 协议（与官方 SDK 一致）：

| `event.type` | 关键字段 | reducer 处理 |
|---|---|---|
| `message_start` | `message: {id, role, model, usage}` | 新建 streaming `UIMessage`，按 id 索引 |
| `content_block_start` | `index`, `content_block: {type, ...}` | 在 `blocks[index]` 创建 block；type ∈ `text` / `thinking` / `tool_use` |
| `content_block_delta` | `index`, `delta: {type, ...}` | 累加：`text_delta.text` / `thinking_delta.thinking` / `input_json_delta.partial_json` / `signature_delta.signature` |
| `content_block_stop` | `index` | `block.partial = false`；`tool_use` 尝试 `JSON.parse(_partialJson)` → `input` |
| `message_delta` | `delta.stop_reason`, `delta.stop_sequence`, `usage`, `context_management` | 更新 message 状态 |
| `message_stop` | — | `streaming = false` |

### 关键不变量
- 事件次序：`message_start` → (`content_block_start` → `delta*` → `_stop`)\* → `message_delta` → `message_stop`。
- `parent_tool_use_id` 非空 = subagent 嵌套消息，UI 应缩进或挂在父工具卡下。
- `partial_json` 完成前别尝试解析为 `tool_use.input`，期间 UI 显示 `streaming…`。
- `delta.type` 可能新增（如未来加 `citations_delta`）—— 必须容错。

---

## 4. assistant（完整快照）

```json
{
  "type": "assistant",
  "message": {
    "id": "msg_xxx",
    "role": "assistant",
    "model": "claude-opus-4-7",
    "content": [ { "type": "text", "text": "..." }, ... ],
    "usage": { ... },
    "stop_reason": "end_turn" | null,
    "context_management": null | { ... }
  },
  "parent_tool_use_id": null | "...",
  "session_id": "...",
  "uuid": "..."
}
```

**reducer 策略**：以 `message.id` 查找已存在的 streaming `UIMessage`：
- 命中 → 用完整 content 覆盖、`streaming = false`（流式中后端可能漏 delta，最终快照兜底）。
- 未命中 → 直接追加（兼容关闭 `--include-partial-messages` 的场景）。

---

## 5. user（含 tool_result 回写）

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_xxx",
        "content": <string | block[]>,
        "is_error": false
      }
    ]
  },
  "parent_tool_use_id": null | "...",
  "session_id": "...",
  "uuid": "..."
}
```

UI 上把 tool_result 卡紧贴对应的 tool_use 卡（通过 `tool_use_id` 关联）。

---

## 6. result（每轮结束）

```json
{
  "type": "result",
  "subtype": "success" | "error",
  "result": "最终文本",
  "total_cost_usd": 0.179,
  "duration_ms": 3094,
  "duration_api_ms": 3073,
  "num_turns": 1,
  "is_error": false,
  "stop_reason": "end_turn",
  "terminal_reason": "completed",
  "modelUsage": {
    "claude-opus-4-7[1m]": {
      "inputTokens": 6,
      "outputTokens": 21,
      "cacheCreationInputTokens": 28646,
      "cacheReadInputTokens": 0,
      "costUSD": 0.17959,
      "contextWindow": 1000000,
      "maxOutputTokens": 64000,
      "webSearchRequests": 0
    }
  },
  "permission_denials": [],
  "usage": { ... },
  "fast_mode_state": "off"
}
```

UI 用途：
- 右栏 cost / token / budget 进度条更新。
- `setStreaming(false)`。
- `permission_denials` 非空时显眼提示。

---

## 7. rate_limit_event

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "rateLimitType": "five_hour" | "one_hour" | "weekly" | ...,
    "resetsAt": <unix-seconds>,
    "status": "allowed" | "rejected" | "near_limit" | ...,
    "isUsingOverage": false,
    "overageDisabledReason": "...",
    "overageStatus": "..."
  },
  "session_id": "...",
  "uuid": "..."
}
```

UI 通常做轻量 chip 提示，不打断对话流。

---

## 8. content block 类型（content[] 内）

```ts
{ type: "text",       text: string }
{ type: "thinking",   thinking: string, signature?: string }
{ type: "tool_use",   id: string, name: string, input: object }
{ type: "tool_result", tool_use_id: string, content: string | block[], is_error?: boolean }
{ type: "image",      source: { type: "base64", media_type: string, data: string } }
```

`tool_use.input` 在 streaming 期间可能是 `{}`，由 `input_json_delta` 累积。

---

## 9. 工具名 → UI 图标映射（lucide-react）

| 工具 | 图标 |
|---|---|
| Read | `FileText` |
| Edit / MultiEdit / NotebookEdit | `FileEdit` |
| Write | `FilePlus` |
| Bash / PowerShell | `Terminal` |
| Grep / Glob | `Search` |
| 其他（含 MCP） | `Wrench` |

新增工具走 `MessageCard.tsx::toolIcon`，无需改 reducer。

---

## 10. 桌面端发送给 stdin 的格式

每条一行 JSON，`\n` 结尾，UTF-8。

```json
{ "type": "user", "message": { "role": "user", "content": [<blocks>] } }
```

`content` 同 §8。多模态发送：`text` block + `image` block 共存。

---

## 11. Tauri 事件协议（Rust → 前端）

| event 名 | payload 类型 | 说明 |
|---|---|---|
| `claude://session/<sid>/event` | `serde_json::Value` | stdout 一行 JSON 解析后透传 |
| `claude://session/<sid>/error` | `string` | stderr 一行 |

非 JSON 行包成 `{type: "raw", line: "..."}` 后照样走 `event` 通道。

---

## 12. 给接手 Agent 的实施提示

- **不要在 Rust 层强类型化事件**：CLI schema 漂移频繁，`serde_json::Value` 透传 + 前端 reducer 容错最稳。
- **`_partialJson` 是私有累积区**，仅 reducer 内部使用；不要在 UI 直接展示。
- **未知 `type` / `subtype` / `delta.type` 永不丢弃**，都落 `UIUnknown` / `raw` 卡。
- **`uuid` 字段**可作为去重 key（重连场景）；UI 默认不显示。
- **`parent_tool_use_id` 非空** = subagent 嵌套；P0 暂时按主流程渲染，P3 再做缩进可视化。
- **`hook_event`** 暂未样本化，遇到时先按 `UIUnknown` 渲染并采集样本。
- **新增字段** = CLI 加的；删字段 = CLI 移的。任何字段都用可选读，不要 `.unwrap()`。
