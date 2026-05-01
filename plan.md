# Claudinal 实施计划

> 更新日期：2026-05-01
>
> 这份文档记录当前代码库的真实状态、已经变更或废弃的需求，以及后续任务优先级。它不再作为开发流水账使用；历史实现记录只在必要时沉淀为架构约束或待办事项。

---

## 0. 当前结论

Claudinal 当前已经进入“核心功能可用，下一步以稳定性、收口和真实场景验证为主”的阶段。

- 已完成：Tauri 2 + React 19 桌面外壳、Claude CLI stream-json 会话、流式渲染、历史会话恢复、SQLite 会话元数据缓存、会话置顶 / 重命名 / 归档 / 删除、notify 监听刷新、Composer 参数选择、图片和文本附件、`@` 文件补全、`/` 命令补全、权限弹窗、Git 状态和 diff、设置页大部分分类、MCP 管理、插件与技能管理、网络代理、账号与用量、第三方 API provider、本地 API 代理、Windows 打包脚本。
- 部分完成：工作树相关目前只保存项目环境脚本；没有真正创建 / 清理 / 派生 worktree。统计只覆盖 GUI 写入 sidecar 的 result，不代表所有 CLI 历史都完整有成本数据。第三方 API key 仍存本地配置，需要迁到系统钥匙串。
- 需要实测：真实 `pnpm tauri dev` 下完成一轮新会话、恢复历史会话、权限审批、图片附件、MCP、代理、插件操作和打包回归。
- 需求已变更：SQLite 只做可重建元数据缓存，不作为 transcript 事实源；不再做右侧 Context Panel，不再做 fork session 菜单，不再接管插件 OAuth flow，不做浏览器 viewport 假字段，不做 append-system-prompt / agents JSON 编辑器。

---

## 1. 产品定位与不变量

### 1.1 目标

Claudinal 是 Claude Code CLI 的桌面外壳，目标用户是不想长时间在终端里操作 Claude Code、但仍希望使用官方 CLI 能力的开发者。

### 1.2 不变量

- 不重造 agent loop。Prompt、工具调度、上下文编辑、hooks、skills、plugins、MCP 执行都交给官方 `claude` CLI。
- 不重复存储 transcript。`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` 是会话内容的单一事实源。
- 不静默兜底。失败要暴露给用户或日志，不能为了“看起来可用”而返回假成功、吞错误或绕开真实 CLI。
- 不默认扩大权限。权限允许、写入项目本地规则、跳过权限都必须来自用户明确选择。
- GUI 只管理自己有把握的配置。对 CLI 原生文件的写入必须范围清晰，可解释，可手动恢复。

### 1.3 明确不做

- 不在桌面端执行 Bash / Read / Write / Edit 等工具。
- 不解析或执行 plugin / skill 的内部行为。
- 不做云同步、团队协作、托管执行环境。
- 不把浏览器自动化做成内置运行时；浏览器能力通过 Claude CLI 可加载的 MCP 暴露。

---

## 2. 当前技术栈

| 层级 | 当前实现 | 说明 |
| --- | --- | --- |
| 桌面壳 | Tauri 2 | Rust 后端 + WebView 前端，当前使用自定义 splash 协议和无边框窗口 |
| 后端 | Rust、tokio、serde、notify、reqwest、keyring、rusqlite | 子进程管理、jsonl 读取、SQLite 元数据缓存、文件监听、代理、系统钥匙串、CLI 命令桥 |
| 前端 | React 19、TypeScript、`useReducer` | 当前没有 Zustand；核心会话状态由 `src/lib/reducer.ts` 归并事件 |
| UI | shadcn/ui 风格手写组件、Radix、Tailwind CSS v4、lucide-react | 设置页、弹窗、侧边栏、Composer、diff 等控件统一走本地组件 |
| 数据 | Claude jsonl、SQLite index、Claudinal sidecar、localStorage、系统钥匙串 | jsonl 是事实源；SQLite 只缓存会话列表元数据；sidecar 只保存 GUI 补充数据 |
| 打包 | Tauri bundler、NSIS、ZIP 脚本 | Windows 已跑通过；macOS / Linux 脚本存在，仍需平台实测 |

已经同步修正的旧口径：

- README 已从 `Zustand` 改为 `useReducer`，SQLite 描述已改成“可重建元数据缓存”，避免被理解为 transcript 存储。
- `plan.md` 旧版本里提到的 Context Panel、SQLite 作为事实源、fork session 等已经不再是当前路线。

---

## 3. 当前架构

### 3.1 进程层

核心入口：

- `src-tauri/src/proc/manager.rs`
- `src-tauri/src/proc/spawn.rs`
- `src-tauri/src/commands.rs::spawn_session`

当前启动命令形态：

```text
claude -p
  --input-format stream-json
  --output-format stream-json
  --include-partial-messages
  --include-hook-events
  --verbose
  --permission-prompt-tool <stdio 或 MCP tool>
```

按用户选择追加：

- `--model <model>`
- `--effort <low|medium|high|xhigh|max>`
- `--permission-mode <default|acceptEdits|plan|bypassPermissions>`
- `--resume <sessionId>`
- `--mcp-config <runtime merged config>`

stdout 逐行解析 JSON，普通事件 emit 到：

```text
claude://session/<runtimeSessionId>/event
```

stderr 单独 emit 到：

```text
claude://session/<runtimeSessionId>/error
```

`control_request` 不进入普通消息流，转为权限请求：

```text
claudinal://permission/request
```

### 3.2 会话存储层

核心入口：

- `src-tauri/src/session/reader.rs`
- `src-tauri/src/session/watcher.rs`
- `src-tauri/src/session/stats.rs`

当前策略：

- 历史 transcript 直接读取 Claude CLI 写入的 jsonl。
- GUI sidecar 写在同一 Claude project 目录下，文件名为 `<sessionId>.claudinal.json`。
- SQLite index 位于系统应用数据目录的 `Claudinal/session-index-v1.sqlite3`，只缓存 session id、jsonl 路径、mtime、大小、消息数、AI 标题和首条用户文本。
- sidecar 目前保存 `result` 和会话级 `composer` 偏好。
- `list_project_sessions(cwd)` 先枚举 jsonl 文件元数据；mtime、大小、路径未变化时直接读 SQLite 缓存，只有新增或变更的 jsonl 才重新扫描正文。
- `notify` watcher 只监听当前可见、展开或置顶相关项目的 jsonl 变化，并做 200ms 节流；刷新时会自然更新 SQLite 缓存。
- SQLite schema 可升级；如果未来 schema 需要破坏性变化，删除并重建 index 即可，不迁移或改写用户 transcript。

### 3.3 前端事件归并

核心入口：

- `src/lib/reducer.ts`
- `src/components/MessageStream.tsx`
- `src/components/MessageBlocks.tsx`

事件原则：

- `stream_event` 负责流式累积 `message_start`、`content_block_*`、`message_delta`、`message_stop`。
- 完整 `assistant` 事件如果命中已有 message id，则覆盖最终 blocks，但不提前关闭 streaming。
- `user` 事件中的 `tool_use_result` 会附着到对应 `tool_result` block。
- 未知事件进入 unknown/raw 卡片，不丢弃。
- 历史 transcript 加载时过滤 CLI 内部事件，例如 `queue-operation`、`attachment`、`ai-title`、`deferred_tools_delta`、`skill_listing`。

### 3.4 配置层

GUI 读写范围：

- `~/.claude/settings.json`
- `~/.claude/mcp.json`
- `<cwd>/.mcp.json`
- `~/.claude/CLAUDE.md`
- `<cwd>/CLAUDE.md`
- `<cwd>/.claude/CLAUDE.local.md`
- `localStorage`
- OS keychain

重要约束：

- MCP runtime config 会合并 global + project + 内置权限 MCP，然后写入临时 JSON 给 CLI。
- 代理密码已经迁到 OS keychain；keychain 不可用时前端显式显示明文存储警告。
- 第三方 API key 当前还在 localStorage，需要迁移到 keychain。

---

## 4. 已实现功能清单

### 4.1 应用外壳

- [x] Tauri 2 + Vite + React 19 + TypeScript 项目结构。
- [x] 自定义 splash window，主窗口延迟创建。
- [x] 无边框窗口、顶部 AppChrome、可隐藏侧边栏。
- [x] `React.lazy` 拆分设置页、插件页、消息流、Composer 等大组件。
- [x] 字体资源和主题初始化脚本，降低首屏闪烁。

### 4.2 流式对话

- [x] 检测 `claude` CLI，支持环境变量 `CLAUDE_CLI_PATH` 覆盖。
- [x] 新建会话、恢复会话、发送 user content blocks、停止会话。
- [x] stdout stream-json 解析和前端 reducer 流式渲染。
- [x] stderr 单独展示。
- [x] user / assistant / thinking / tool_use / tool_result / image / system / result / rate_limit / raw / unknown 等消息卡片。
- [x] Markdown 渲染、代码块、工具调用折叠、工具结果分流。
- [x] 图片粘贴、拖拽、文件选择、图片预览与移除。
- [x] 文本文件附件读取并包装为 `<uploaded_file>` 文本块。
- [x] Esc 中断当前会话。
- [x] streaming 中继续按 Enter 时进入排队体验，result 后解除本地排队状态。
- [x] `/clear` / `/reset` 由 GUI 拦截清空当前视图，不发送给 CLI。

### 4.3 Composer 与参数

- [x] Model / Effort Picker。
- [x] 内置模型 alias：best、sonnet、opus、haiku、sonnet[1m]、opus[1m]、opusplan。
- [x] Effort 支持 auto、low、medium、high、xhigh、max。
- [x] 会话级 model/effort 写入 sidecar，恢复历史会话时还原。
- [x] 全局默认读取 `~/.claude/settings.json`，必要时回落 app settings。
- [x] `max` 只做会话级选择，不写入 `settings.json::effortLevel`。
- [x] 权限模式选择：default、acceptEdits、plan、bypassPermissions。
- [x] Composer 加号菜单内置计划模式 toggle。
- [x] `/` 命令补全，候选来自 system init 缓存和内置 fallback。
- [x] 高频 slash command 置顶。
- [x] `@` 文件补全，Rust 侧 `list_files(cwd, prefix)`。
- [x] Git 分支显示、搜索、切换、新建并切换。
- [x] OAuth plan usage 小圆环提示。

### 4.4 项目与历史会话

- [x] 项目列表存储在 `localStorage["claudecli.projects"]`。
- [x] SQLite 会话元数据缓存：保持 `list_project_sessions(cwd)` API 不变，内部用 mtime/size/path 判断缓存新鲜度。
- [x] 添加项目支持系统目录选择、路径输入、不存在自动创建。
- [x] 侧边栏项目搜索、项目展开、历史会话懒加载。
- [x] 历史会话标题优先级：自定义标题 > AI title > 首条用户文本。
- [x] 会话置顶，置顶区跨项目显示。
- [x] 会话重命名，本地保存。
- [x] 会话归档，归档后从置顶区和项目区隐藏。
- [x] 设置页归档列表支持恢复和删除 jsonl。
- [x] 删除当前会话 jsonl，并同步删除 sidecar、置顶、归档残留引用。
- [x] 复制会话 ID，复制 `claude --resume <id>` 命令。
- [x] notify watcher 监听已展开、当前项目和置顶相关项目，jsonl 变化后刷新侧边栏。

### 4.5 Git 与 diff

- [x] Git 工作树状态：branch、upstream、ahead/behind、changed files、additions/deletions。
- [x] 当前工作树 patch 解析，支持未跟踪文本文件内容展示。
- [x] ChatHeader 显示 diff 入口和变更数量。
- [x] DiffOverview 合并会话工具补丁、Git patch、Git status。
- [x] 支持 create/update/delete/binary 等不同展示。
- [x] 设置页 Git 分类读写 `settings.json` 的 attribution、includeGitInstructions、prUrlTemplate。
- [x] GitHub CLI 安装和认证状态检测。
- [x] 提交指令 / PR 指令写入 `~/.claude/CLAUDE.md` 的哨兵区段。

### 4.6 权限审批

- [x] 默认使用 Claude CLI `--permission-prompt-tool stdio` 控制协议。
- [x] stdout `control_request` 转 GUI 弹窗。
- [x] GUI 返回 `control_response`。
- [x] 支持允许、拒绝、此次会话允许所有编辑、此次会话允许此类工具、写入项目本地规则。
- [x] session 级授权不落盘。
- [x] `localSettings` 写入必须来自用户明确点击。
- [x] 可选内置 MCP 权限 server：`--permission-mcp-server`。
- [x] MCP 权限桥能够通过 GUI resolve 请求。
- [x] 保留 `result.permission_denials` 渲染作为显式失败信息。

### 4.7 设置页

当前设置页是全屏工作区，不再是早期小弹窗。

- [x] 常规：自动检查更新开关、默认权限模式、MCP 权限工具配置。
- [x] 外观：light/dark/system、预设、浅色/深色双套 accent/background/foreground、UI 字体、代码字体、半透明侧栏、对比度滑块、重置。
- [x] 配置：读写 `~/.claude/settings.json` 的 model、effortLevel、language、alwaysThinkingEnabled；只读导出配置。
- [x] 第三方 API：多 provider、Anthropic / OpenAI Chat Completions 格式字段、模型列表拉取、本地代理映射、恢复官方 Claude。
- [x] 个性化：全局 / 项目 / 项目本地 CLAUDE.md 编辑，高频 slash command 置顶。
- [x] MCP 服务器：global/project mcp.json，stdio/http，env/headers/auth，启停、编辑、卸载、重复提示，Claude CLI config 只读展示。
- [x] Git：见 4.5。
- [x] 环境：项目环境列表、设置脚本、清理脚本、平台差异脚本。
- [ ] 工作树：当前仍是 Placeholder。
- [x] 浏览器使用：浏览器 MCP 诊断、一键添加 playwright、Playwright 浏览器缓存检测。
- [x] 已归档对话：列表、恢复、删除。
- [x] 账户和使用情况：`claude auth status --json`、登录、登出、重新登录、OAuth usage。
- [x] 统计：全局 sidecar usage 聚合、模型拆分、最近 30 天活跃热力图。
- [x] 网络代理：HTTP/HTTPS/SOCKS5/SOCKS5h、NO_PROXY、测试连接、密码 keychain。

### 4.8 MCP、插件与技能

- [x] MCP 配置读取、编辑、启停、卸载。
- [x] 自动识别浏览器 MCP。
- [x] 插件页：已安装、发现、Marketplace 三个视图。
- [x] 插件安装 / 卸载 / Marketplace 添加 / 刷新 / 移除。
- [x] 技能列表，按来源分组。
- [x] 本地技能导入。
- [x] 内置 `playwright-cli` 技能安装器。
- [x] Composer 加号菜单能显示已安装插件并跳转插件管理。

### 4.9 网络与第三方 API

- [x] 代理配置只注入 Claude 子进程。
- [x] SOCKS 代理通过本地 HTTP CONNECT bridge 适配子进程。
- [x] 代理测试按钮。
- [x] 代理密码 keychain 存储和旧明文迁移。
- [x] 第三方 API provider 通过本地 sidecar proxy 转发。
- [x] `/models` / `/v1/models` 在 sidecar proxy 内部直接返回已配置模型。
- [x] 请求体模型字段按 provider 映射重写。
- [x] 支持 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_API_KEY` 两种认证字段映射。
- [ ] 第三方 API key 仍需迁入 keychain。

### 4.10 打包

- [x] `pnpm build` / `pnpm tauri build` 脚本。
- [x] Windows NSIS、MSI 脚本。
- [x] macOS app/dmg/universal 脚本。
- [x] Linux deb/rpm/appimage 脚本。
- [x] ZIP 便携包脚本。
- [x] NSIS 离线引导脚本。
- [x] Windows 上曾实测安装包和便携包产出。
- [ ] macOS / Linux 平台打包未见当前实测记录。

---

## 5. 需求变更与废弃清单

本节专门记录执行过程中已经改变的需求，避免后续开发继续按旧计划推进。

| 原需求 | 当前处理 | 原因 |
| --- | --- | --- |
| SQLite 作为 transcript 存储或唯一事实源 | 废弃，已改为可重建元数据缓存 | 既提前解决大量会话列表性能，又保证未来 schema 变化不会破坏用户 jsonl |
| 右侧 Context Panel | 废弃 | model/effort/permission 已进入 Composer，cost/usage 进入 Account/Statistics，diff 进入 ChatHeader，右栏会挤压对话空间 |
| fork session / `--fork-session` 菜单 | 废弃 | 用户反馈命名晦涩、实际场景少；如果以后重做，命名为“派生到新工作树”，并与 Git worktree 流程绑定 |
| 插件 OAuth flow 接管 | 取消 | `claude plugin --help` 没有 auth/login/needs-auth 子命令；私有 marketplace 鉴权依赖 git credential helper / ssh-agent |
| 浏览器 viewport 设置 | 不做 | Claude CLI 不消费这个字段；浏览器 MCP 自己负责浏览器配置 |
| `--append-system-prompt` 和 agents JSON 编辑器 | 不做 | 保持 prompt 来源集中到 CLAUDE.md，避免来源分裂 |
| 全局 PATH 追加 / GUI 环境变量列表 | 不做 | 容易与 OAuth、settings.json env、第三方 API 注入冲突；高级配置直接编辑 settings.json |
| webview 全应用代理 | 暂不做 | Tauri 2 稳定代理 API 未作为当前依赖；当前只保证 Claude 子进程代理 |
| PAC URL | 暂不做 | 子进程代理已经覆盖主要需求；PAC 复杂度高，放 P4 |
| CodeMirror merge view | 暂缓 | 当前 UnifiedDiff 已能满足只读审查；只有要做交互式文件编辑时再引入 |
| 自研工具执行层 | 明确不做 | 违反“不重造 agent”不变量 |
| 假成功 / mock 成功路径 | 明确不做 | 违反 Debug-First 策略 |

---

## 6. 当前已知问题与缺口

这些不是新功能，而是当前实现与文档、配置或真实使用之间的缺口。

### 6.1 文档与现实不一致

- README 的核心技术栈和会话管理描述已同步；后续若调整设置项或数据口径，需要继续保持 README 和本计划一致。

### 6.2 配置项未完全接线

- `AppSettings.claudeCliPath` 字段存在，但当前 CLI 检测只读取环境变量 `CLAUDE_CLI_PATH` 和 PATH，需要决定接入 UI 写入环境，或删除该字段。
- `autoCheckUpdate` 有设置项，但当前未看到真实 GitHub release 检查流程，需要实现或改成“预留项”。
- Config 页面与 General 页面对默认 permission mode 的职责有重叠，需要统一口径。

### 6.3 安全存储缺口

- 代理密码已经走 keychain。
- 第三方 API provider 的 API key 仍在 localStorage，需要迁移到 keychain，且迁移过程必须显式可见、失败时暴露错误。

### 6.4 平台兼容缺口

- OAuth usage 当前读取 `~/.claude/.credentials.json`，macOS 上 CLI 凭据可能在 Keychain，当前需要明确支持状态。
- 打包脚本覆盖 macOS/Linux，但缺少当前平台实测记录。

### 6.5 稳定性与测试缺口

- 需要系统化跑 `pnpm build`、`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo check --manifest-path src-tauri/Cargo.toml`。
- 需要真实 CLI 集成验证权限 stdio、MCP 权限桥、resume、delete、proxy、third-party provider。
- 需要为 reducer、session reader、Git patch parser、MCP config merge、proxy URL 构造补充针对性测试。

---

## 7. 后续路线图

### P0：发布前收口和真实验证

目标：确认当前功能闭环可靠，修正明显错口径和未接线配置。

- [ ] 跑一轮真实 `pnpm tauri dev` 新会话：发送文本、流式输出、工具调用、result、sidecar 写入。
- [ ] 跑历史会话恢复：加载 transcript、继续发送、验证 `--resume`、验证 composer sidecar 还原。
- [ ] 跑权限审批：stdio allow/deny/session allow/localSettings 四条路径。
- [ ] 跑 MCP 权限桥：启用内置 MCP 权限工具，验证 request 能进同一弹窗。
- [ ] 跑附件：图片粘贴 / 拖拽 / 选择，文本文件附件，错误文件大小提示。
- [ ] 跑 Sidebar watcher：新 result 后会话列表刷新，置顶和归档同步刷新。
- [ ] 跑删除和归档：二次确认、sidecar 清理、置顶/归档引用清理。
- [ ] 跑网络代理：HTTP 和 SOCKS 至少各一条可用路径，确认失败信息可读。
- [ ] 跑第三方 API provider：模型拉取、应用 provider、本地 proxy 请求映射。
- [ ] 跑插件页：list、marketplace add/update/remove、plugin install/uninstall、skill import。
- [ ] 跑 Git/diff：dirty repo、untracked text、binary、branch switch/create。
- [ ] 跑 `pnpm build`。
- [ ] 跑 `cargo test --manifest-path src-tauri/Cargo.toml`。
- [ ] 跑 `cargo check --manifest-path src-tauri/Cargo.toml`。
- [x] 更新 README 中过时的 Zustand / Context Panel 描述，并把 SQLite 说明改成可重建元数据缓存。
- [ ] 处理 `claudeCliPath` 字段：实现 GUI 配置注入，或删除字段与文档。
- [ ] 处理 `autoCheckUpdate`：实现 release check，或把设置项标记为预留。

### P1：稳定性和数据安全

目标：减少真实用户遇到的配置损坏、密钥泄漏和平台差异问题。

- [ ] 第三方 API key 迁移到 OS keychain。
- [ ] `settings.json` 写入改为临时文件 + rename 的原子写，与 MCP 写入保持一致。
- [ ] 给 `write_text_file` 增加明确用途审视；如果只为设置页导出服务，限制到可解释范围。
- [ ] Account 页明确 macOS OAuth token 读取策略：支持 Keychain 或清晰提示不可读取。
- [ ] 统一 Config / General / Composer 对 model、effort、permission 的职责边界。
- [ ] 为 session reader 补测试：ASCII cwd 编码、Unicode 兼容目录、sidecar 读写、删除同步。
- [ ] 增加会话索引诊断和“重建 SQLite 索引”入口；索引损坏时明确提示，不静默降级到全量扫描。
- [ ] 为 reducer 补测试：partial streaming、assistant 覆盖、tool_use_result 附着、unknown 保留。
- [ ] 为 Git patch parser 补测试：rename、delete、binary、untracked text。
- [ ] 为 MCP merge 补测试：global/project 覆盖、disabled 过滤、权限 MCP 合并。
- [ ] 为 proxy 补测试：URL 构造、NO_PROXY、SOCKS bridge env 改写。

### P2：体验补齐

目标：补上高价值但不改变底层架构的体验缺口。

- [ ] 独立历史会话视图：搜索、按项目筛选、按时间 / 消息数 / cost 排序。
- [ ] 会话搜索先做元数据和首条用户文本；消息全文搜索只有在性能验证后再做。
- [ ] Account / Statistics 的用量口径统一：OAuth plan usage、GUI sidecar usage、CLI result cost 要分别标注。
- [ ] diff 面板支持复制文件路径、复制 patch、按来源筛选。
- [ ] 插件安装失败时把 git credential / SSH / HTTPS 报错做成可读诊断弹窗。
- [ ] Network 页增加从 settings.json env 清理冲突代理的显式操作，执行前二次确认。
- [ ] Appearance 对比度滑块如果继续保留，需要接入真实 CSS 变量；否则移除。
- [ ] 浏览器页补充 Playwright MCP 常见错误诊断，而不是只做安装检测。

### P3：工作树能力

目标：只有在用户确实需要并确认交互模型后才推进。

- [ ] 工作树设置页从 Placeholder 变为真实配置页。
- [ ] 默认 worktree 根目录。
- [ ] 创建工作树前展示预览：目标路径、基础分支、setup script、风险提示。
- [ ] 创建工作树后运行项目环境 setup script。
- [ ] 清理工作树前运行 cleanup script，并明确展示将删除的路径。
- [ ] 自动清理已合并 worktree，需要用户确认清理策略。
- [ ] 如果重新引入 `--fork-session`，只能命名为“派生到新工作树”，并绑定 worktree 创建流程。

### P4：低优先级和外部依赖项

- [ ] 基于 SQLite index 做全局历史会话视图和跨项目搜索；只读索引，不改变 jsonl 事实源。
- [ ] PAC URL 支持。
- [ ] webview 全应用代理。
- [ ] macOS / Linux 打包和签名完整流程。
- [ ] 自动更新。
- [ ] CI 多平台矩阵。
- [ ] 插件 enable/disable 持久化：等待 Claude CLI 暴露稳定路径。
- [ ] MCP OAuth 诊断：只做状态说明和外部配置指引，不做 GUI OAuth 接管。

---

## 8. 关键文件地图

### 8.1 Rust 后端

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/lib.rs` | Tauri builder、插件注册、命令注册、splash/main window 创建 |
| `src-tauri/src/commands.rs` | Tauri commands 聚合，包含会话、Git、MCP、settings、proxy、auth 等 |
| `src-tauri/src/proc/manager.rs` | Claude 子进程生命周期、stdin/stdout/stderr、权限 control 协议 |
| `src-tauri/src/proc/spawn.rs` | `claude` CLI 路径定位 |
| `src-tauri/src/session/reader.rs` | jsonl 元数据扫描、transcript 读取、sidecar 读写、删除 |
| `src-tauri/src/session/watcher.rs` | notify watcher，监听 jsonl 变化 |
| `src-tauri/src/session/stats.rs` | sidecar usage 和活跃热力图扫描 |
| `src-tauri/src/permission_mcp.rs` | 内置 MCP 权限工具 server 和 GUI bridge |
| `src-tauri/src/api_proxy.rs` | 第三方 API sidecar proxy |
| `src-tauri/src/network_proxy.rs` | SOCKS 到 HTTP CONNECT bridge |
| `src-tauri/src/keychain.rs` | OS keychain 封装 |
| `src-tauri/src/auth.rs` | `claude auth` 状态、登录、登出 |
| `src-tauri/src/plugins.rs` | Claude plugin / marketplace / skill 文件系统与命令桥 |
| `src-tauri/src/startup.rs` | 自定义 splash URI 协议 |

### 8.2 React 前端

| 文件 | 职责 |
| --- | --- |
| `src/App.tsx` | 顶层状态、会话生命周期、项目切换、设置/插件/聊天视图切换 |
| `src/lib/reducer.ts` | Claude 事件归并为 UIEntry |
| `src/lib/ipc.ts` | Tauri invoke/listen typed wrapper |
| `src/components/Composer.tsx` | 输入区、附件、命令补全、文件补全、参数、权限、Git 分支 |
| `src/components/Sidebar.tsx` | 项目、历史会话、置顶、watcher 刷新 |
| `src/components/ChatHeader.tsx` | 会话操作、diff 入口、置顶、归档、删除 |
| `src/components/DiffOverview.tsx` | 会话补丁 + Git patch + status 汇总展示 |
| `src/components/PermissionDialog.tsx` | 权限审批弹窗 |
| `src/components/PluginsView/index.tsx` | 插件、Marketplace、技能管理 |
| `src/components/Settings/index.tsx` | 设置工作区和分类路由 |
| `src/lib/thirdPartyApi.ts` | 第三方 API provider store 和 env 构造 |
| `src/lib/proxy.ts` | 代理配置、keychain 迁移、env 构造 |
| `src/lib/composerPrefs.ts` | 全局默认、会话覆盖、旧偏好迁移 |
| `src/lib/projects.ts` | 项目列表 localStorage |
| `src/lib/pinned.ts` | 置顶会话 localStorage |
| `src/lib/archivedSessions.ts` | 归档会话 localStorage |
| `src/lib/projectEnv.ts` | 项目环境脚本配置 |

---

## 9. 验证标准

### 9.1 常规命令

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
pnpm tauri dev
```

Windows 打包：

```bash
pnpm package:exe
pnpm package:zip
```

### 9.2 手工回归清单

- 新项目添加、切换、移除。
- 新会话发送文本并完成 result。
- 发送期间继续输入，确认排队 UI 和 result 后状态。
- 恢复历史 session，继续发送并写回同一 jsonl。
- 权限请求 allow/deny/session allow/localSettings。
- 图片和文本附件。
- `/` 命令补全、置顶命令、`@` 文件补全。
- Git dirty 状态、diff 面板、分支切换、新建分支。
- 归档、取消归档、删除会话。
- MCP server 添加、禁用、删除。
- 插件安装、卸载、Marketplace 刷新。
- 代理保存、测试连接、keychain 状态。
- 第三方 API provider 新增、模型拉取、应用、恢复官方 Claude。
- 账号登录、登出、usage 刷新。

### 9.3 失败处理标准

- CLI 不存在：明确提示路径检测失败。
- settings/mcp JSON 损坏：显示解析错误，不自动覆盖。
- 权限响应失败：弹 toast 并保留弹窗。
- 代理测试失败：展示完整错误链。
- 插件命令失败：展示 stdout/stderr，不返回假成功。
- sidecar 读写失败：日志或 toast 暴露，不影响 transcript 本体。

---

## 10. 设计约束

- 组件优先复用现有 shadcn 风格 primitives。
- 图标使用 `lucide-react`。
- 设置页分类保持“左侧导航 + 右侧内容”的工作区形态。
- 长列表使用 `ScrollArea`。
- 不使用浏览器 `alert` / `prompt`。
- 卡片只用于重复项、弹窗、工具面板；主聊天消息保持轻量。
- 文本必须在窄屏下可换行，不允许按钮或卡片文字溢出。
- 新增持久化 key 要有命名空间，优先 `claudinal.*` 或已有 `claudecli.*` 约定。
- 敏感信息优先 OS keychain；不能用 keychain 时必须明确提示。

---

## 11. 下一步执行顺序

最推荐的下一轮开发顺序：

1. 先做真实回归验证，记录失败点。
2. 修正 README 和配置项口径不一致。
3. 迁移第三方 API key 到 keychain。
4. 补 reducer、session reader、MCP merge、proxy URL 的测试。
5. 收口 `claudeCliPath` 和 `autoCheckUpdate` 两个未接线设置项。
6. 再评估是否进入独立历史会话视图和工作树能力。

在 P0/P1 完成前，不建议新增大功能。当前最有价值的是把已有功能跑稳，并把文档、设置项和真实行为统一起来。
