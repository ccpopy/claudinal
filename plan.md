# Claudinal 实施计划

> 更新日期：2026-05-04
>
> 这份文档记录当前代码库的真实状态、已经变更或废弃的需求，以及后续任务优先级。它不再作为开发流水账使用；历史实现记录只在必要时沉淀为架构约束或待办事项。

---

## 0. 当前结论

Claudinal 当前已经进入“核心功能可用，下一步以稳定性、收口和真实场景验证为主”的阶段。

- 已完成：Tauri 2 + React 19 桌面外壳、Claude CLI stream-json 会话、流式渲染、历史会话恢复、SQLite 会话元数据缓存、会话置顶 / 重命名 / 归档 / 删除、notify 监听刷新、Composer 参数选择、图片和文本附件、`@` 文件补全、`/` 命令补全、权限弹窗、Git 状态和 diff、设置页大部分分类、MCP 管理、插件与技能管理、项目环境操作工具栏、网络代理、账号与用量、第三方 API provider、本地 API 代理、Windows 打包脚本、协同 CLI gate 记录、协同设置页、Composer 协同徽标、协同 MCP server 首版、外部 Agent provider 探测、线性执行持久化、协同流程视图、协同会话绑定和流程删除联动。
- 部分完成：工作树设置页已支持查看当前 Git 仓库已有 worktree、添加为项目并删除外部工作树；默认根目录、创建流程、自动清理策略和会话派生入口仍待确认。协同能力已确定为独立功能，不放在工作树设置内；首版代码已经落地，已在真实 GUI 使用中暴露并修复 Codex Windows sandbox、流程列表刷新、会话绑定和弹窗滚动问题，但仍需要系统化 `pnpm tauri dev` 回归覆盖设置保存、新会话 MCP 注入、Claude 通过 MCP 发起只读/写入委派、错误展示和重启后的流程恢复。统计只覆盖 GUI 写入 sidecar 的 result，不代表所有 CLI 历史都完整有成本数据。第三方 API key 仍存本地配置，需要迁到系统钥匙串。
- 最近验证：2026-05-04 已通过 `pnpm build`、`cargo check --manifest-path src-tauri/Cargo.toml`、`cargo test --manifest-path src-tauri/Cargo.toml`。仍需要真实 `pnpm tauri dev` 下完成新会话、恢复历史会话、权限审批、图片附件、MCP、代理、项目操作、插件操作和打包回归。
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

- 不在桌面端实现 Claude 工具层的 Bash / Read / Write / Edit。只有用户在项目环境页显式配置的项目操作命令可由 GUI 触发，并必须展示真实 exit code、stdout、stderr。
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
- SQLite index 位于 Claudinal 应用根 `.claudinal/session-index-v1.sqlite3`；开发模式写到仓库根 `.claudinal/session-index-v1.sqlite3`，打包后写到 exe 同级目录 `.claudinal/session-index-v1.sqlite3`。索引只缓存 session id、jsonl 路径、mtime、大小、消息数、AI 标题和首条用户文本。
- sidecar 目前保存 `result` 和会话级 `composer` 偏好。
- `list_project_sessions(cwd)` 先枚举 jsonl 文件元数据；mtime、大小、路径未变化时直接读 SQLite 缓存，只有新增或变更的 jsonl 才重新扫描正文。
- `notify` watcher 只监听当前可见、展开或置顶相关项目的 jsonl 变化，并做 200ms 节流；刷新时会自然更新 SQLite 缓存。
- SQLite schema 可升级；当前表保留 `indexed_at` 兼容旧缓存表，缺列时显式补列。未来如果 schema 需要破坏性变化，删除并重建 index 即可，不迁移或改写用户 transcript。

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

### 3.5 项目环境与操作

核心入口：

- `src/lib/projectEnv.ts`
- `src/components/Settings/sections/Environment.tsx`
- `src/components/ProjectActionsBar.tsx`
- `src-tauri/src/commands.rs::run_project_action`

当前策略：

- 项目环境配置保存在 `localStorage["claudinal.project-env"]`。
- 每个项目可保存显示名称、setup script、cleanup script、平台差异脚本和项目操作命令。
- 项目操作在主对话页显示为“项目操作”工具栏，只有用户点击时才执行。
- `run_project_action` 会在项目根目录下通过系统 shell 执行命令，并注入 `CLAUDINAL_WORKTREE_PATH=<cwd>`。
- 命令结果不做假成功：前端展示真实 exit code、stdout、stderr；执行失败通过 toast 暴露。
- setup / cleanup 脚本目前仍只是配置项；工作树设置页只管理已有 Git worktree，不自动创建目录或运行生命周期脚本。

### 3.6 协同能力首版

协同能力已经作为独立功能接入，入口位于“设置 -> 协同”和 Composer 加号菜单，不放在“工作树”设置里。工作树只是可选的工作区隔离资源，不是协同功能本身。

当前模型：

- 使用线性单工作区模式作为首版：同一协同流程同一时间只允许一个 Agent 执行写入步骤，后续步骤必须等待前一步完成、记录输出并通过确认或验证后才能开始。
- 默认 Agent 是 Claude CLI。Codex、Gemini、opencode 可被探测和配置，但是否启用交给用户决定；默认只启用 Claude。
- 允许 Claude、Codex、Gemini、opencode 写入，但每个写入步骤必须有明确责任范围、允许路径、状态机、输出记录、变更清单和验证结果。
- 不把协同等同于 Git worktree。首版不依赖 worktree，也不要求项目必须是 Git 仓库；如果项目是 Git 仓库，可以用 Git diff 做验证和展示。如果不是 Git 仓库，必须用显式文件清单、mtime/hash 快照或运行结果记录变更，不能静默假装有 diff。
- Claude CLI 仍是主会话和最终整合者。外部 Agent 通过 Claudinal 提供的 MCP 工具被受控调用，不能让 Claude 直接自由拼 shell 命令去调用 `codex`、`gemini` 或 `opencode`。
- 协同接近 workflow / skills 的产品体验，但不是 skills：skills 是给单个 Agent 的提示和流程知识；协同是 Claudinal 管理的跨 CLI 执行、状态持久化、权限和产物验证功能。
- 协同 CLI gate 记录在 `doc/collab-cli-gate-2026-05-03.md`，实现依据该记录中的官方文档和本机 `--help` 核验结果。

Composer 交互：

- 加号菜单已经新增“协同”项。
- 点击后像图片附件一样在输入框上方显示“协同”徽标，表示下一条消息进入协同模式；发送后清除徽标；选择菜单项后下拉层会关闭。
- 如果协同设置未启用，点击入口会引导到“设置 -> 协同”，不会隐式开启。
- 如果当前 Claude 会话启动时没有加载协同 MCP，会提示当前会话不可用；协同 MCP 按“新会话生效”处理，不做动态补载。

MCP 工具边界：

- `collab_status`：返回当前项目协同是否启用、可用 Agent、当前流程状态。
- `collab_start_flow`：创建协同流程，记录用户需求、项目、主 Claude session id。
- `collab_delegate`：按配置调用指定 Agent，并记录输入、命令、工作目录、权限模式和输出。
- `collab_get_result`：读取某一步结构化结果和原始 stdout/stderr 摘要。
- `collab_record_approval`：记录用户或 Claude 对某一步的确认、退回或继续。
- `collab_run_verification`：运行用户配置或系统建议的验证命令，记录真实 exit code、stdout、stderr。

持久化与执行策略：

- 协同状态保存到 Claudinal 应用根下 `.claudinal/collaboration-v1`；开发模式写到仓库根 `.claudinal/collaboration-v1`，不写入 Claude transcript，不依赖 SQLite。
- 每一步保存输入 prompt、目标 Agent、责任范围、状态、开始/结束时间、退出码、结构化输出、原始 stdout/stderr 路径、验证结果和变更文件清单。
- Claude runtime session id 会在 `system/init` 后映射到真实 Claude jsonl session id；流程绑定使用真实会话 id，删除会话时级联删除对应 flow、run 日志和 lock 文件。
- 状态机显式使用 `draft`、`running`、`completed`、`failed`、`approved`、`rejected`、`verified`、`cancelled`。只有当前步骤达到允许流转的状态，下一步才能开始。
- 对写入步骤，开始前记录允许修改范围，结束后用工作区 mtime/hash 快照比对实际变更；越界修改显式标记失败或冲突。
- 外部 CLI 退出非零时记录真实 exit code、stdout、stderr，步骤进入失败状态；不会重试、模拟成功或自动换 Agent。
- Codex provider 在 Windows 下显式传入 `-c windows.sandbox=unelevated`，避免继承用户全局 `windows.sandbox=elevated` 后触发 `CreateProcessWithLogonW failed: 1326`；仍保留 Codex 的 `read-only/workspace-write` sandbox 策略。

---

## 4. 已实现功能清单

### 4.1 应用外壳

- [x] Tauri 2 + Vite + React 19 + TypeScript 项目结构。
- [x] 自定义 splash window，主窗口延迟创建。
- [x] 无边框窗口、顶部 AppChrome、可隐藏侧边栏。
- [x] 顶部菜单“文件 -> 返回对话”和左上返回按钮可从设置 / 插件页回到当前对话；设置页内恢复归档会话或编辑项目环境时可记录返回目标。
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
- [x] 权限弹窗限制最大高度，主体和长参数区超出时显示统一滚动条，避免参数撑出屏幕。
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
- [x] 环境：项目环境列表、显示名称、设置脚本、清理脚本、平台差异脚本、项目操作新增 / 编辑 / 删除。
- [x] 工作树：设置页可列出当前仓库已有 Git worktree，支持打开、添加为项目并删除。
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

### 4.11 项目环境与操作

- [x] 项目环境页“本地环境”布局改为上下结构，避免目录卡片和名称表单横向挤压。
- [x] 项目操作支持新增、编辑、删除并保存到 `claudinal.project-env`。
- [x] 主对话页按当前项目显示“项目操作”工具栏。
- [x] 项目操作点击后在当前项目目录下运行用户配置命令。
- [x] 操作结果弹窗展示 exit code、stdout、stderr；失败不静默吞掉。
- [x] 执行环境注入 `CLAUDINAL_WORKTREE_PATH`。
- [ ] setup / cleanup 脚本尚未接入真实 worktree 创建和清理流程。

### 4.12 协同能力首版

- [x] 新增 `doc/collab-cli-gate-2026-05-03.md`，记录官方文档和本机 CLI `--help` 核验结论。
- [x] 新增 `src-tauri/src/collab/` 模块，拆分 provider 探测、runner、store、MCP server 和文件变更检测。
- [x] 主程序支持 `--collab-mcp-server`，可作为 Claudinal 协同 MCP stdio server 启动。
- [x] 启用协同时，新 Claude 会话会合并 `claudinal_collab` MCP runtime config；当前已启动会话不会生效。
- [x] Tauri commands 暴露 `collab_detect_providers`、`collab_detect_provider`、`collab_list_flows`、`collab_read_flow`、`collab_start_flow`、`collab_delegate`、`collab_record_approval`、`collab_run_verification`。
- [x] MCP 工具实现 `collab_status`、`collab_start_flow`、`collab_delegate`、`collab_get_result`、`collab_record_approval`、`collab_run_verification`。
- [x] Provider 探测支持 Claude、Codex、Gemini、opencode，设置页逐个探测并先渲染列表；未安装或参数不匹配时展示真实错误。
- [x] 协同设置保存到 `localStorage["claudinal.collaboration.settings"]`，支持启用开关、默认 Agent、默认允许写入、默认责任范围、默认允许路径、每个 provider 的启用状态、自定义路径和职责范围。
- [x] 默认 Agent 为 Claude CLI，默认只启用 Claude；Codex、Gemini、opencode 探测结果只作为信息，是否启用由用户决定。
- [x] Composer 加号菜单新增“协同”，点击后显示和附件类似的协同徽标，发送后清除。
- [x] Composer 加号菜单选择“协同”后会关闭下拉层，不保留悬浮菜单。
- [x] 同一 flow 使用 `FlowLock` 限制同一时间只有一个运行步骤。
- [x] 写入步骤使用 mtime/hash 工作区快照记录 added/modified/deleted，非 Git 项目也能记录变更清单；Git 只作为后续可选 diff 能力。
- [x] 只读步骤发生文件变更会失败；写入步骤越出允许路径会失败。
- [x] Agent 非零退出记录真实 exit code、stdout、stderr 路径和摘要，不做重试、mock 或自动切换 Agent。
- [x] 协同流程视图已接入 ChatHeader：可按项目查看 flow 列表、步骤、stdout/stderr 预览、结构化输出、文件变更、验证记录和审批操作；打开后会定时静默刷新。
- [x] 协同流程绑定真实 Claude jsonl session id；删除会话会级联删除对应 flow 与 run 日志，列表刷新不做破坏性清理。
- [x] Codex Windows provider 调用已固定 `windows.sandbox=unelevated`，修复 elevated Windows sandbox 缺凭据导致的 `CreateProcessWithLogonW failed: 1326`。
- [ ] 仍需要在真实 `pnpm tauri dev` 下验证从设置启用到新会话 MCP 注入、只读委派、写入委派、失败展示、流程恢复的完整链路。

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
| PAC URL | 暂不做 | 子进程代理已经覆盖主要需求；PAC 复杂度高，放低优先级 |
| CodeMirror merge view | 暂缓 | 当前 UnifiedDiff 已能满足只读审查；只有要做交互式文件编辑时再引入 |
| 自研工具执行层 | 明确不做 | 违反“不重造 agent”不变量 |
| 假成功 / mock 成功路径 | 明确不做 | 违反 Debug-First 策略 |

---

## 6. 当前已知问题与缺口

这些不是新功能，而是当前实现与文档、配置或真实使用之间的缺口。

### 6.1 文档与现实不一致

- README 的核心技术栈和会话管理描述已同步；后续若调整设置项或数据口径，需要继续保持 README 和本计划一致。

### 6.2 配置项未完全接线

- Config 页面与 General 页面对默认 permission mode 的职责有重叠，需要统一口径。

### 6.3 安全存储缺口

- 代理密码已经走 keychain。
- 第三方 API provider 的 API key 已迁移到 OS keychain（`src/lib/thirdPartyApi.ts` 提供 `loadThirdPartyApiStoreAsync` / `saveThirdPartyApiStoreAsync` / `migrateLegacyThirdPartyApiKeys`，App 启动时一次性把旧明文条目搬到钥匙串）；keychain 不可用时降级回 localStorage 并通过设置页警告 banner 暴露明文存储状态。

### 6.4.1 会话期间网络错误可见性

- 之前代理失效时，stderr 会以 stderr entry 静默追加到对话流末尾，没有 toast 提示，用户在滚动会话时容易错过；现增加 `src/lib/networkErrorHints.ts` 与 App.tsx `reportNetworkError`：
  - 监听 stderr 与 result.is_error 文本，按代理 / TLS / DNS / 超时 / 连接被拒 / 限流 / 鉴权 / 5xx 八类模式识别。
  - 命中后弹 toast.error（标题 + 修复建议 + 原始错误片段），含「网络设置」action 直接打开 Network 设置页。
  - 同一 runtime 同 topic 30 秒内只弹一次，避免持续刷屏；会话关闭时清掉节流条目。
  - 单测 `src/lib/networkErrorHints.test.ts` 覆盖 12 个场景。

### 6.4 平台兼容缺口

- OAuth usage 当前读取 `~/.claude/.credentials.json`：Linux/Windows 上 CLI 写到该文件可正常工作；macOS 上 CLI 凭据存系统钥匙串（"Claude Code-credentials"），Claudinal 不读取系统钥匙串，会显式返回平台说明错误并在 Account 页提示。
- 打包脚本覆盖 macOS/Linux，但缺少当前平台实测记录。

### 6.5 稳定性与测试缺口

- `pnpm build`、`cargo test --manifest-path src-tauri/Cargo.toml`、`cargo check --manifest-path src-tauri/Cargo.toml` 已在 2026-05-04 通过；后续需要纳入每轮发布前固定回归。`pnpm test`（vitest）也加入 reducer 单测（14 cases）。
- 需要真实 CLI 集成验证权限 stdio、MCP 权限桥、resume、delete、proxy、third-party provider。
- 需要为 session reader、Git patch parser、MCP config merge、proxy URL 构造补充针对性测试（reducer 已覆盖）。

### 6.6 协同功能待收口

- 协同 CLI gate、设置页、Composer 入口、MCP server、provider 探测、线性锁、步骤持久化、stdout/stderr 记录、mtime/hash 变更清单、流程视图和流程恢复入口已经落地。
- 当前协同数据落在 Claudinal 应用根 `.claudinal/collaboration-v1`，开发模式落在仓库根 `.claudinal/collaboration-v1`；不落 Claude transcript，也不依赖 Git 仓库或 SQLite。
- 当前还缺系统化 GUI 集成回归：需要在 `pnpm tauri dev` 中验证启用协同、新建 Claude 会话、MCP 注入、Claude 调用协同工具、只读委派、写入委派、失败展示、关闭重开后的流程恢复。
- 协同流程视图已经能集中查看每一步输出、验证记录和等待状态；下一步重点是回归运行中刷新、会话删除级联、旧 flow 兼容和错误态展示，而不是重新实现视图。
- Provider 探测已经能展示安装、版本、help 参数和失败原因，但认证状态仍以真实 CLI 执行结果为准；如果 Agent 需要登录或版本不兼容，运行步骤会失败并记录真实输出。
- opencode 本机未安装，provider 探测必须继续显示未安装状态，不能 mock。
- 当前默认 Agent 是 Claude CLI，默认只启用 Claude；其他 provider 即使探测可用，也必须由用户显式启用。

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
- [ ] 跑项目操作：新增操作、保存、返回主对话、执行成功命令、执行失败命令、查看 stdout/stderr。
- [ ] 跑 Git/diff：dirty repo、untracked text、binary、branch switch/create。
- [x] 跑 `pnpm build`。最近一次通过：2026-05-04。
- [x] 跑 `cargo test --manifest-path src-tauri/Cargo.toml`。最近一次通过：2026-05-04。
- [x] 跑 `cargo check --manifest-path src-tauri/Cargo.toml`。最近一次通过：2026-05-04。
- [x] 更新 README 中过时的 Zustand / Context Panel 描述，并把 SQLite 说明改成可重建元数据缓存。
- [x] 处理 `claudeCliPath` 字段：从 `AppSettings` 删除未接线字段，CLI 路径统一走 `CLAUDE_CLI_PATH` 环境变量与 PATH 检测。
- [x] 处理 `autoCheckUpdate`：已通过 `@tauri-apps/plugin-updater` 在启动时静默检查、设置页提供"立即检查"按钮（`src/lib/updater.ts`、`src/App.tsx`、`src/components/Settings/sections/General.tsx`）。

### P1：稳定性和数据安全

目标：减少真实用户遇到的配置损坏、密钥泄漏和平台差异问题。

- [x] 第三方 API key 迁移到 OS keychain：`thirdPartyApi.ts` 在 keychain 可用时按 provider id 写入，启动时静默迁移旧明文；keychain 不可用时降级到 localStorage 并显示警告。
- [x] `settings.json` 写入改为临时文件 + rename 的原子写，与 MCP 写入保持一致：`commands.rs` 引入 `atomic_write_str`，`write_claude_settings` / `write_claude_md` / `write_text_file` / `write_claude_json_mcp_servers` 全部统一走原子写；`session/reader.rs::write_session_sidecar` 也改成临时文件+rename。
- [x] 给 `write_text_file` 增加明确用途审视：函数注释明确唯一调用方为「设置页导出配置」，路径来自系统对话框选择，不再做额外白名单。
- [x] Account 页明确 macOS OAuth token 读取策略：`fetch_oauth_usage` 在 macOS 平台 + token 不在文件时显式返回带说明的错误，前端 PlanUsageSection 文案同步更新；明确 Claudinal 不读取系统钥匙串。
- [x] 统一 Config / General / Composer 对 model、effort、permission 的职责边界：删除未接线的 `AppSettings.defaultModel` / `defaultEffort`，加载链改为 `composerPrefs → ~/.claude/settings.json → 空`；Config 页与 General 页加文案说明会话级覆盖在 Composer。
- [x] 为 session reader 补测试：ASCII cwd 编码、Unicode 兼容目录、`project_dirs` 双路径、`validate_session_id` 路径穿越拦截、`is_internal_command_text` 标签校验、`title_candidate` 多字节截断（位于 `src-tauri/src/session/reader.rs::tests`）。
- [x] 增加会话索引诊断和「重建 SQLite 索引」入口：`session::store::diagnostics()` / `rebuild()` + Tauri 命令 `session_index_diagnostics` / `rebuild_session_index`；「设置 -> 已归档对话」底部展示 db 路径、schema 版本（与期望不一致时高亮）、文件大小和各派生表行数，按钮支持手动诊断 / 重建（带二次确认），重建仅清空派生表，不动 jsonl / sidecar。
- [x] 为 reducer 补测试：partial streaming（含 input_json_delta 解析、index 跨号占位）、assistant 覆盖（含中途快照不关闭 streaming）、tool_use_result 附着（含 tool_use endedAt 打点）、unknown / raw / stderr 保留、协同 prompt 前缀剥离、内部 command echo 过滤、user_local 排队 / unqueue 移位 / drop / reset、load_transcript 内部事件过滤。`pnpm test` 接入 vitest 4.1.5。
- [x] 为 Git patch parser 补测试：已在 `src-tauri/src/commands.rs::tests` 覆盖 hunk 解析、rename（`parse_git_status_z_keeps_rename_source`）、worktree 列表（`parse_git_worktree_porcelain_reads_branch_and_detached_entries`）等场景；后续如需 binary / untracked text 再追加。
- [x] 为 MCP merge 补测试：`merge_mcp_config` global/project 覆盖、保留顶层 key、disabled 字段更新、非 object 源拒绝；`runtime_mcp_config` 禁用过滤与全部禁用返回 None；`mcp_config_from_value` 仅取 `mcpServers` 子树；`mcp_project_config_from_claude_json` 大小写 / 反斜杠归一化匹配；`claude_project_key_for_write` 复用既有 key 变体。
- [x] 为 proxy 补测试：URL 构造（含 username/password URL-encode）、NO_PROXY 默认值与覆盖、各 protocol 透传、describeProxy 状态分支。
- [x] 顺带补 `thirdPartyApi.ts`（buildClaudeEnv env 注入、normalize、clearManagedClaudeEnv、maskSecret、providerModelOptions、createThirdPartyApiProvider、trimApiUrl）和 `composerPrefs.ts`（mergeComposerPrefs / pickComposerFromSidecar / pickComposerFromTranscript / composerPrefsPatchFromCommandEvent / effortSource / isClaudeModelEntry）的单测。`pnpm test` 共 66 cases 通过。

### P2：体验补齐

目标：补上高价值但不改变底层架构的体验缺口。

- [x] 跨项目历史会话搜索 + 按项目筛选 + 按时间 / 消息数 / 标题排序：直接增强 SearchPalette（顶部加排序 + 项目过滤 + 计数 + 清除筛选），元数据排序与正文 FTS 并存。完整全屏视图保留到 P5（基于 SQLite index）。
- [x] 会话搜索元数据 + 首条用户文本：SearchPalette 已基于 jsonl 元数据 + sidecar 标题 + 全文 FTS 查询。
- [x] Account / Statistics 用量口径统一：Account 的「计划用量限额」加 Anthropic OAuth Badge + 来源说明；Statistics 顶部说明数据源 = GUI sidecar，加 GUI sidecar Badge，明确不计 CLI 直接发起的会话。
- [x] diff 面板支持复制文件路径、复制 patch、按来源筛选：DiffOverview 顶部加 来源 chip（全部 / 会话 / Git / 状态）+「复制全部 patch」按钮；当前文件标题旁加复制路径 / 复制本文件 patch；patch 重新拼成标准 unified diff 格式。
- [x] 插件安装失败时做可读诊断：新增 `src/lib/pluginErrorHints.ts` 按关键词识别 git 凭据 / SSH / HTTPS / TLS / 网络 / 权限 / 磁盘 / Claude CLI / Git 缺失等场景，给可执行 hint；PluginsView 各路径错误调 `reportPluginError(action, error)` 弹长 toast 含 hint + 复制原始错误。
- [x] Network 页冲突代理清理：检测 `settings.json` env 中 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`（含小写）冲突字段，提供「一键清理冲突变量」按钮，二次确认后从 settings.json 中删除（保留其他 env 字段）。
- [x] Appearance 对比度滑块：删除未接线的 contrast 字段与 UI（`AppearanceConfig.contrast`、Codex 预设值、`isAppearanceEqual` 比较、`Appearance.tsx` 滑块、`RangeRow` 都已移除）。
- [x] 浏览器页 Playwright MCP 错误诊断：检测到 MCP 状态 failed/error 时展开诊断卡片，列出 5 类常见原因（npx 缺失、Playwright 浏览器缺失、网络、权限、注册表）；同时检测 `settings.json` 中的 `PLAYWRIGHT_*` 环境变量并在另一个卡片提示是否会影响。

### P3：协同能力

目标：首版已经从规划进入实现阶段。下一步不是重新设计，而是做真实 GUI 回归、错误路径验证和用户可见流程展示收口。

已完成 gate：

- [x] 查证并记录官方调用方式：Claude CLI MCP / stream-json、Codex `exec` 非交互、Gemini headless、opencode `run` / `serve`。记录见 `doc/collab-cli-gate-2026-05-03.md`。
- [x] 本机运行 `claude --help`、`codex exec --help`、`gemini --help`；本机 opencode 未安装，`opencode run --help` 记录为命令不存在。
- [x] 明确协同 MCP 不能动态注入当前已启动会话，按“设置启用后新会话生效”实现。
- [x] 后端已具备只读和写入委派的 runner 封装，能捕获 exit code、stdout、stderr、结构化输出和文件变更。

首版已落地：

- [x] 新增“设置 -> 协同”分类，用户可启用/禁用协同，配置 Agent provider、可执行路径、默认 Agent、默认责任范围、默认权限、是否允许写入。
- [x] Provider 探测：Claude、Codex、Gemini、opencode；展示安装状态、版本、help 参数、失败原因。探测列表先渲染，再逐个更新。
- [x] 每个 provider 可单独启用；探测出可用不等于自动启用。
- [x] 每个 provider 支持自定义路径和职责范围；默认职责范围按 Claude、Codex、Gemini、opencode 的常见优势填入。
- [x] Composer 加号菜单新增“协同”，点击后显示协同徽标；发送消息时把协同要求包装进当前用户消息。
- [x] Composer 加号菜单选择协同后会关闭弹层；协同模式是单次发送标记，发送后清除，不会让后续普通问题自动继续协同。
- [x] 新增 Claudinal 协同 MCP server，并在启用协同时合并进 Claude runtime MCP config。
- [x] MCP 工具实现 `collab_status`、`collab_start_flow`、`collab_delegate`、`collab_get_result`、`collab_record_approval`、`collab_run_verification`。
- [x] 实现线性执行锁：同一项目同一协同流程同一时间只有一个 Agent run 可以处于 `running`。
- [x] 实现线性单工作区写入策略：外部 Agent 可以写入，但每个步骤必须有一个 Agent、一个责任范围、一个状态机和一个完成记录。
- [x] 实现步骤持久化：输入 prompt、Agent、命令、cwd、权限、stdout/stderr、结构化输出、变更文件清单、验证结果。
- [x] 实现越界变更检测：写入步骤结束后对比允许范围与实际变更，越界时流程暂停并标记失败。
- [x] 实现协同流程视图：ChatHeader 入口可查看项目 flow 列表、步骤详情、stdout/stderr、结构化输出、验证记录、文件变更和审批操作，并在打开时定时静默刷新。
- [x] 实现协同流程与真实 Claude jsonl session id 绑定：runtime id 在 Claude `system/init` 后映射到真实 session id；删除会话时级联删除对应 flow 和 run 产物。
- [x] 修复 Codex Windows sandbox 调用：协同委派 Codex 时显式传 `windows.sandbox=unelevated`，避免 elevated helper 缺凭据失败，同时保留 Codex 的读写 sandbox 策略。

剩余收口：

- [ ] 在 `pnpm tauri dev` 中完成真实端到端验证：设置启用协同、新建 Claude 会话、MCP 注入、Claude 调用 `collab_status`、创建 flow、只读委派、写入委派、审批、验证、恢复。
- [ ] 真实验证 Agent 错误路径：未登录、版本不兼容、命令非零退出、JSON 解析失败、用户禁用 provider。
- [ ] 回归协同流程视图：运行中刷新、完成后保留、关闭重开恢复、旧 runtime-id flow 兼容、会话删除级联和 Windows 文件占用场景。
- [ ] 为 provider 探测、runner、store、changes、MCP 工具补充针对性单元测试或集成测试。

明确暂不做：

- [x] 暂不做并行写入；并行只允许后续扩展到只读分析。
- [x] 暂不默认创建或绑定 Git worktree；worktree 是未来可选隔离策略，不是协同首版依赖。
- [x] 暂不接管外部 CLI 登录流程；只检测并展示状态，登录仍由各 CLI 官方方式完成。
- [x] 暂不把 CCB 作为 runtime 嵌入；只参考 Agent 命名、消息路由和 worktree 隔离设计。

### P4：工作树能力

目标：只有在用户确实需要并确认交互模型后才推进。

- [x] 工作树设置页从 Placeholder 变为真实列表页。
- [ ] 默认 worktree 根目录。
- [ ] 创建工作树前展示预览：目标路径、基础分支、setup script、风险提示。
- [ ] 创建工作树后运行项目环境 setup script。
- [ ] 清理工作树前运行 cleanup script，并明确展示将删除的路径。
- [ ] 自动清理已合并 worktree，需要用户确认清理策略。
- [ ] 如果重新引入 `--fork-session`，只能命名为“派生到新工作树”，并绑定 worktree 创建流程。

### P5：低优先级和外部依赖项

- [x] 基于 SQLite index 做全局历史会话视图和跨项目搜索：新增 `src/components/HistoryView/index.tsx` 全屏视图，复用 `list_recent_sessions_all` + `search_sessions`（FTS5），支持搜索、按项目筛选、按最近活动 / 消息数 / 标题排序、含归档开关、清除筛选；侧边栏新增「历史会话」入口。
- [ ] PAC URL 支持。（依赖嵌入 JS 引擎评估 FindProxyForURL，本机暂未做。）
- [ ] webview 全应用代理。（Tauri 2 builder 阶段配置，需要平台稳定性测试，单独 spike。）
- [ ] macOS / Linux 打包和签名完整流程。（需平台机器实测，本机为 Windows，跳过。）
- [ ] CI 多平台矩阵。（与上一项绑定，等待 macOS/Linux 打包基线。）
- [ ] 插件 enable/disable 持久化：等待 Claude CLI 暴露稳定路径（外部依赖未到位）。
- [x] MCP OAuth 诊断：MCP server 状态为 needs-auth / failed 时在卡片底部展开诊断条，给出 `claude mcp authenticate <name>` 指引、网络/代理/证书排查清单；不接管 OAuth 流程。

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
| `src-tauri/src/commands.rs::run_project_action` | 用户显式配置的项目操作命令执行桥，返回 exit code/stdout/stderr |

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
| `src/components/ProjectActionsBar.tsx` | 当前项目操作工具栏和命令输出弹窗 |
| `src/components/PluginsView/index.tsx` | 插件、Marketplace、技能管理 |
| `src/components/Settings/index.tsx` | 设置工作区和分类路由 |
| `src/lib/thirdPartyApi.ts` | 第三方 API provider store 和 env 构造 |
| `src/lib/proxy.ts` | 代理配置、keychain 迁移、env 构造 |
| `src/lib/composerPrefs.ts` | 全局默认、会话覆盖、旧偏好迁移 |
| `src/lib/projects.ts` | 项目列表 localStorage |
| `src/lib/pinned.ts` | 置顶会话 localStorage |
| `src/lib/archivedSessions.ts` | 归档会话 localStorage |
| `src/lib/projectEnv.ts` | 项目环境脚本、清理脚本、项目操作配置 |

### 8.3 协同功能文件

这些文件已经成为协同首版的实际边界；后续收口时应沿用当前职责划分，避免把外部 Agent 调用逻辑散落到聊天主流程里。

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/collab/mod.rs` | 协同功能模块入口 |
| `src-tauri/src/collab/providers.rs` | Claude / Codex / Gemini / opencode provider 定义、探测、版本检测 |
| `src-tauri/src/collab/runner.rs` | 外部 CLI 非交互调用、stdout/stderr 捕获、退出码和超时处理 |
| `src-tauri/src/collab/store.rs` | 协同 flow、step、agent run、verification 的 `.claudinal/collaboration-v1` JSON 持久化、线性锁、runtime session 映射和 flow 删除 |
| `src-tauri/src/collab/mcp.rs` | Claudinal 协同 MCP server 和工具实现 |
| `src-tauri/src/collab/changes.rs` | 写入步骤前后文件清单、mtime/hash、非 Git 变更检测 |
| `src-tauri/src/lib.rs` | 注册协同 Tauri commands，并暴露 `run_collab_mcp_server()` |
| `src-tauri/src/main.rs` | 识别 `--collab-mcp-server` 启动参数 |
| `src-tauri/src/commands.rs` | 新会话注入协同 MCP 环境和 runtime config，暴露协同 Tauri commands，并在删除会话时级联删除绑定 flow |
| `src/lib/collabSettings.ts` | 协同设置 localStorage wrapper、默认 provider 职责范围、启用 provider 列表 |
| `src/lib/ipc.ts` | 协同 Tauri command 的 typed wrapper 和数据结构 |
| `src/App.tsx` | 协同模式状态、新会话 MCP 注入参数、协同 prompt 包装、当前会话不可用提示和协同流程视图入口 |
| `src/components/Settings/sections/Collaboration.tsx` | “设置 -> 协同”页面 |
| `src/components/Composer.tsx` | 加号菜单协同入口和协同徽标 |
| `src/components/CollaborationFlow.tsx` | 协同流程抽屉视图：flow 列表、步骤详情、输出预览、结构化输出、文件变更、验证记录、审批操作和定时刷新 |

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
- 项目操作新增、保存、主对话页执行、stdout/stderr 展示。
- 代理保存、测试连接、keychain 状态。
- 第三方 API provider 新增、模型拉取、应用、恢复官方 Claude。
- 账号登录、登出、usage 刷新。

### 9.3 协同功能验证清单

协同每轮实现和回归都必须执行，不允许只凭文档或只凭本机经验推进。

- [x] 官方文档核验：记录 Claude CLI MCP / stream-json、Codex `exec`、Gemini headless、opencode `run` 的链接、日期和关键参数。
- [x] 本机 CLI 核验：记录 `claude --help`、`codex exec --help`、`gemini --help`、`opencode run --help` 输出中的关键参数；opencode 未安装时记录未安装状态。
- [x] Provider 探测命令：后端 Tauri command 已支持全量探测和单 provider 探测，设置页逐个渲染更新。
- [x] MCP server 基础验证：`--collab-mcp-server` 可返回 tools list，包含所有协同工具。
- [x] 构建验证：`pnpm build` 在 2026-05-04 通过。
- [x] Rust 验证：`cargo check --manifest-path src-tauri/Cargo.toml` 和 `cargo test --manifest-path src-tauri/Cargo.toml` 均在 2026-05-04 通过。
- [ ] Provider 探测 GUI 验证：每个 provider 的安装路径、版本、help 参数、失败原因和启用开关都能在设置页稳定展示。
- [ ] 新会话 MCP 注入验证：启用协同后新建 Claude 会话，确认 runtime `--mcp-config` 加载 `claudinal_collab`。
- [ ] 当前会话不可用验证：旧会话或未加载协同 MCP 的会话点击协同时，必须提示当前会话不会生效。
- [ ] 只读委派：在协同模式下让 Claude 通过 MCP 委派一个只读设计或评审任务，结果落盘，UI 或 MCP result 能展示步骤输出。
- [ ] 写入委派：允许一个外部 Agent 在明确责任范围内写入，步骤完成后展示修改文件、stdout/stderr、验证结果。
- [ ] 线性锁：一个 Agent run 正在执行时，下一步不能启动；尝试启动时必须得到明确错误或等待状态。
- [ ] 流程恢复：关闭并重开应用后，能从持久化记录恢复协同流程、步骤状态和上一轮输出。
- [ ] 越界写入：构造一个 Agent 修改责任范围外文件的场景，流程必须暂停并显示冲突，不能自动继续。
- [ ] 非 Git 项目：至少验证协同流程在非 Git 目录下能运行只读步骤；写入步骤必须用 mtime/hash 快照记录变更。
- [ ] 错误处理：CLI 不存在、认证失败、JSON 解析失败、命令非零退出、用户取消，都必须保留真实错误和原始输出摘要。

### 9.4 失败处理标准

- CLI 不存在：明确提示路径检测失败。
- settings/mcp JSON 损坏：显示解析错误，不自动覆盖。
- 权限响应失败：弹 toast 并保留弹窗。
- 代理测试失败：展示完整错误链。
- 插件命令失败：展示 stdout/stderr，不返回假成功。
- 项目操作命令失败：展示 exit code、stdout、stderr，不返回假成功。
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

1. 先做真实 `pnpm tauri dev` 回归验证，记录失败点，尤其覆盖协同启用、新会话 MCP 注入、只读委派、写入委派、错误路径和流程恢复。
2. 回归现有协同流程视图，重点覆盖运行中刷新、完成后保留、关闭重开恢复、会话删除级联、旧 flow 兼容和错误态展示。
3. 为协同 provider 探测、runner、store、changes、MCP 工具补测试，补齐越界写入、非 Git 目录、禁用 provider 和非零退出路径。
4. 修正 README 和配置项口径不一致。
5. 迁移第三方 API key 到 keychain。
6. 补 reducer、session reader、MCP merge、proxy URL、项目操作命令执行的测试。
7. 再评估是否进入独立历史会话视图和真实工作树能力。

在 P0/P1 完成前，新增大功能需要先做独立 spike 和清晰 gate。协同能力的 gate 已完成，后续重点是验证真实执行链路和补齐用户可见的流程反馈。
