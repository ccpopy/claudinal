# 协同 CLI Gate 核验记录

日期：2026-05-03

本记录用于协同功能实现前的强制 gate。结论来自官方文档和本机 CLI `--help` 输出；实现不得依赖记忆或猜测参数。

## 官方文档结论

- Claude Code CLI：官方 CLI reference 记录 `-p/--print`、`--input-format text|stream-json`、`--output-format text|json|stream-json`、`--include-partial-messages`、`--include-hook-events`、`--mcp-config`、`--permission-mode`、`--permission-prompt-tool`。MCP 文档记录 stdio server 形态为 `command` + `args`，可通过 `--mcp-config` 加载。参考：<https://code.claude.com/docs/en/cli-reference>、<https://code.claude.com/docs/en/mcp>。
- Codex CLI：官方 Codex non-interactive 文档要求用 `codex exec`，并记录 `--json` 会把 stdout 变成 JSONL 事件流，`--output-last-message` 可写最终消息，`--output-schema` 可要求最终输出符合 JSON Schema，`--sandbox read-only|workspace-write|danger-full-access` 控制执行权限。参考：<https://developers.openai.com/codex/noninteractive>、<https://developers.openai.com/codex/cli/reference>。
- Gemini CLI：官方 README 和 headless 文档记录非交互模式、`--output-format json`、`--output-format stream-json`、`--approval-mode default|auto_edit|yolo`、退出码 `0/1/42/53`。参考：<https://github.com/google-gemini/gemini-cli>、<https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md>。
- opencode CLI：官方 CLI 文档记录 `opencode run [message..]`、`--format json`、`--session`、`--continue`、`opencode serve`。参考：<https://opencode.ai/docs/cli/>。

## 本机 CLI 核验结论

- `claude --help`：本机可运行，确认存在 `--mcp-config`、`--input-format stream-json`、`--output-format stream-json`、`--permission-mode`。本机 help 未列出 `--permission-prompt-tool`，但 `claude -p --permission-prompt-tool stdio --version` 可正常解析并返回版本；该参数属于现有权限桥差异记录，不作为协同 provider 的必需参数。本机 help 未显示“动态启用 MCP”的参数，因此协同 MCP 按“新会话生效”实现。
- `codex exec --help`：本机可运行，确认存在 `--json`、`--cd`、`--sandbox`、`--output-last-message`、`--output-schema`、`--skip-git-repo-check`。
- `gemini --help`：本机可运行，确认存在 `--output-format text|json|stream-json`、`--approval-mode default|auto_edit|yolo`、`--sandbox`、`--resume`。
- `opencode run --help`：本机未安装，PowerShell 返回 `The term 'opencode' is not recognized`。设置页和 provider 探测必须显示未安装，不能返回 mock 成功。

## 实现约束

- 首版协同不依赖 Git worktree，也不要求项目是 Git 仓库。
- Git 只作为可选 diff 来源；协同变更记录必须使用文件清单与 mtime/hash 快照。
- 外部 Agent 可以写入，但每个写入步骤必须记录 provider、命令、工作目录、责任范围、允许路径、状态、stdout/stderr、变更清单和验证结果。
- 同一协同流程同一时间只能有一个运行中的步骤。后续步骤必须等待上一写入步骤完成后被批准或验证。
