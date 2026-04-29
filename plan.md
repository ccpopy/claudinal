# Claudinal — 实施计划

> Tauri 2 + Rust + React 桌面外壳，包装本机 `claude` CLI 的 headless stream-json 接口。
> **核心原则：不重造 agent，只造一个比 TUI 更好用的外壳。**

---

## 0. 项目定位

- 目标用户：不想使用终端跑 Claude Code 的开发者
- 不做的事：自研 agent loop / 自研工具 / 自研权限系统 / 团队协作 / 云同步 / 内置浏览器自动化（可以通过 MCP）。
- 做的事：流式渲染、会话管理（codex 风）、参数可视化（effort/model/permission/budget）、消息卡片化（claudia 风）、图片粘贴。
- 不变量：所有 agent 行为（prompt / 工具调度 / skills / hooks / context editing）由 `claude` CLI 自己负责。CLI 升级 = 桌面端自动获得新能力。

---

## 1. 技术栈

| 层       | 选择                                           | 理由                                      |
| -------- | ---------------------------------------------- | ----------------------------------------- |
| Shell    | Tauri 2                                        | 体积小，Rust 后端，Windows 友好           |
| 后端     | Rust（tokio + serde + sqlx/rusqlite + notify） | 子进程管理 + transcript 索引 + fs watcher |
| 前端     | React 18 + Vite + TypeScript                   | 主流，生态全                              |
| 状态     | Zustand                                        | 轻量，比 Redux 适合这个规模               |
| UI       | shadcn/ui + Tailwind                           | 卡片/弹窗/下拉一把梭                      |
| Markdown | react-markdown + remark-gfm + rehype-highlight | 渲染 assistant text                       |
| Diff     | @uiw/react-codemirror + diff-match-patch       | Edit/Write 的 before/after                |
| 图标     | lucide-react                                   | shadcn 默认                               |

**关键依赖外部**：本机已安装 `claude` CLI（≥ 2.1.x，需支持 `--input-format stream-json --include-partial-messages --include-hook-events`）。

---

## 2. 架构（三层）

```
┌─ React UI ────────────────────────────────────────────┐
│  Sessions(左) │ MessageStream(中) │ ContextPanel(右) │
└────────────┬──────────────────────────────────────────┘
             │ Tauri IPC（commands + events）
┌────────────┴──────────────────────────────────────────┐
│  Rust 后端                                             │
│  ├─ proc::Manager      子进程 spawn/kill/io           │
│  ├─ proc::StreamParser stream-json → 强类型事件       │
│  ├─ session::Index     SQLite 索引 + fs watcher       │
│  ├─ session::Reader    读 ~/.claude/projects/*.jsonl  │
│  └─ config::Bridge     settings.json / mcp.json 读写   │
└────────────┬──────────────────────────────────────────┘
             │ child process
        ┌────┴─────┐
        │  claude  │  ← 黑盒，不动它
        └──────────┘
```

### 2.1 进程层（proc）

- 一个会话 = 一个 `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --include-hook-events --verbose` 子进程。
- stdin：前端发送的 user message（content blocks，含 image base64）→ 序列化为单行 JSON → 写入子进程 stdin。
- stdout：行分隔的 JSON 事件 → 解析 → Tauri event emit `claude://session/<id>/event`。
- stderr：独立 channel，写本地日志 + 关键错误 emit `claude://session/<id>/error`。
- 中断：发送取消事件到 stdin（如 CLI 支持），否则 `kill_on_drop` + 重新 spawn 用 `--resume`。

### 2.2 会话存储层（session）

- **不重复存储 transcript**——CLI 已经把每条消息写在 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`。
- 桌面端只维护索引：
  ```sql
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT NOT NULL,
    cwd_encoded TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_ts INTEGER,
    last_ts INTEGER,
    msg_count INTEGER,
    model TEXT,
    cost_usd REAL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    summary TEXT,
    status TEXT  -- active / idle / errored
  );
  CREATE INDEX idx_cwd_last ON sessions(cwd, last_ts DESC);
  ```
- 启动时：扫一遍所有 `~/.claude/projects/`，并发解析 jsonl 末尾若干行抽取元数据。
- 运行时：`notify` watcher 监听目录变更，增量更新行。
- UI 直接对 SQLite 做查询（搜索/筛选/排序）。

### 2.3 配置桥（config）

- 读：`~/.claude/settings.json`、`<cwd>/.claude/settings.json`、`<cwd>/.claude/settings.local.json`、mcp 配置。
- 写：仅在用户从 GUI 修改时（如启用某 MCP server / 调整 hooks），原子写。
- 不解析 skills 内容——只列出名字（从 system-reminder 协议无关），UI 上让用户输入 `/<name>` 由 CLI 自己处理。

---

## 3. 前端 UI

### 3.1 布局

```
┌────────────────┬───────────────────────────────────┬──────────────────┐
│                │  顶部：model | effort | perm |    │                  │
│  Sessions      │        cwd | new | fork           │  Context Panel   │
│  (search/      │  ───────────────────────────────  │                  │
│   filter/      │                                   │  - model         │
│   sort)        │       MessageStream               │  - effort slider │
│                │       (cards)                     │  - perm mode     │
│                │                                   │  - cost/budget   │
│                │  ───────────────────────────────  │  - cwd / add-dir │
│                │  Composer: text + image + /       │  - mcp servers   │
└────────────────┴───────────────────────────────────┴──────────────────┘
```

### 3.2 消息卡片类型（来自 stream-json 事件）

| 事件 type                | 渲染                                                   |
| ------------------------ | ------------------------------------------------------ |
| `user` (text)            | 右侧蓝色气泡 + markdown                                |
| `user` (image block)     | 缩略图，点击放大                                       |
| `assistant` (text delta) | 左侧 markdown，逐字流式                                |
| `assistant` (thinking)   | 折叠灰色斜体卡，标头显示 effort 等级                   |
| `tool_use: Read`         | 文件名 + 行范围，点开显示截取内容                      |
| `tool_use: Edit/Write`   | diff 视图（CodeMirror merge），默认折叠                |
| `tool_use: Bash`         | 终端样式，显示 cmd + description；result 区折叠 stdout |
| `tool_use: Grep/Glob`    | 简洁 chip + 结果计数 + 展开列表                        |
| `tool_use: 其他`         | 通用卡：工具名 + 参数 JSON 折叠                        |
| `tool_result`            | 紧贴对应 tool_use，错误高亮                            |
| `permission_request`     | 模态弹窗：工具+参数+diff，allow/deny                   |
| `usage` / `cost`         | 不进流，更新右侧面板                                   |
| `hook_event`             | 侧边小图标 chip，点击查看                              |
| `system` (init/limit)    | 顶部 banner                                            |
| 未知                     | 原样 JSON 折叠                                         |

### 3.3 Composer（输入区）

- 多行 textarea，Shift+Enter 换行，Enter 发送
- `@` 触发 cwd 文件补全（前端调 Rust `list_files(cwd, prefix)`）
- `/` 触发斜杠面板（候选来自 `claude --help` + 内置常用命令；发送时原样写入 user message，由 CLI 解释）
- 粘贴/拖拽图片 → base64 → 多 content block；预览缩略图可删除
- Esc → 中断当前响应

### 3.4 Sessions 面板（codex 风）

- 顶部搜索（消息内文 + summary）
- 筛选：model / 日期范围 / cost 区间 / 状态
- 排序：最近活跃 / 最高 cost / 最多消息 / 创建时间
- 按 cwd 分组（折叠），cwd 显示为 `<basename>` + tooltip 全路径
- 单项右键：恢复 / 分叉 / 在资源管理器打开 cwd / 复制 sessionId / 删除 jsonl
- 顶部 "+" 新建：选 cwd（默认上次）→ 选 model/effort（用上次默认）→ 创建

### 3.5 Context Panel（右栏）

- model 下拉（带成本提示）；effort 滑块（low/medium/high/xhigh/max）——切换后下条消息生效
- permission-mode：default / acceptEdits / plan / bypassPermissions（带颜色警示）
- cost：当前会话累计 + budget 进度条（来自 `--max-budget-usd`）
- token：input / output / cache_read / cache_write
- cwd：主目录 + add-dir 列表（增删）
- MCP：列出 active servers + 状态点（来自 init system 事件）

---

## 4. 事件 schema 适配

完整 schema 见 [`doc/events.md`](./doc/events.md)（基于 CLI 2.1.123 真实样本 [`doc/stream-json-1.txt`](./doc/stream-json-1.txt)）。要点：

- **顶层 `type`**：`system` / `stream_event` / `assistant` / `user` / `result` / `rate_limit_event` / 未来扩展。
- **`stream_event.event.type`**（Anthropic Messages 流协议）：`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`。
- **content block 类型**：`text` / `thinking` / `tool_use` / `tool_result` / `image`。

### Rust 侧策略

直接 `serde_json::Value` 透传到前端，**不强类型化**。理由：CLI schema 漂移频繁，前端 reducer 容错足够灵活，Rust 强 enum 反而成升级阻塞点。文件：`src-tauri/src/proc/manager.rs`。

### 前端 reducer 策略（`src/lib/reducer.ts`）

- `message_start` → 新建 streaming `UIMessage`，按 `message.id` 索引。
- `content_block_*` → 在对应 `index` 上累积 `text` / `thinking` / `_partialJson`（私有）。
- `content_block_stop` → 完成 partial：`tool_use` 尝试 `JSON.parse(_partialJson) → input`。
- `message_delta` / `message_stop` → 更新 `stop_reason` / `streaming`。
- 完整 `assistant` 事件命中已存在 id 时覆盖 blocks，否则新增（兼容关闭 partial 的场景）。
- 未知 `type` 落 `UIUnknown` 卡，**永不丢弃**。

---

## 5. 目录结构

```
F:\project\claudecli\
├─ plan.md
├─ README.md
├─ package.json
├─ pnpm-lock.yaml         # 用 pnpm
├─ vite.config.ts
├─ tsconfig.json
├─ tailwind.config.ts
├─ index.html
├─ src/                   # React
│  ├─ main.tsx
│  ├─ App.tsx
│  ├─ components/
│  │  ├─ Sessions/
│  │  ├─ MessageStream/
│  │  ├─ Composer/
│  │  ├─ ContextPanel/
│  │  └─ ui/              # shadcn
│  ├─ hooks/
│  ├─ stores/             # zustand
│  ├─ lib/
│  │  ├─ ipc.ts           # tauri invoke 封装
│  │  └─ events.ts        # 事件类型定义
│  └─ types/
└─ src-tauri/             # Rust
   ├─ Cargo.toml
   ├─ tauri.conf.json
   ├─ build.rs
   └─ src/
      ├─ main.rs
      ├─ lib.rs
      ├─ commands.rs      # tauri command exports
      ├─ proc/
      │  ├─ mod.rs
      │  ├─ manager.rs    # 子进程池
      │  ├─ spawn.rs      # claude 启动
      │  └─ events.rs     # stream-json 解析
      ├─ session/
      │  ├─ mod.rs
      │  ├─ index.rs      # sqlite
      │  ├─ reader.rs     # jsonl 读取
      │  └─ watcher.rs    # fs notify
      └─ config/
         └─ mod.rs
```

---

## 6. MVP 切片

### P0：流式对话（2 周）

- [x] 写 plan.md
- [x] 项目脚手架（Tauri 2 + Vite + React + TS + lucide-react）
- [x] Rust：`detect_claude_cli` command（基于 `which`，支持 `CLAUDE_CLI_PATH` 覆盖）
- [x] Rust：`spawn_session(cwd, model, effort, permission_mode) -> SessionId`
- [x] Rust：`send_user_message(session_id, content_blocks)`
- [x] Rust：`stop_session(session_id)`
- [x] Rust：stream-json 行解析，`emit("claude://session/<id>/event", value)`
- [x] 前端：单会话页 + 消息流 + Composer
- [x] 前端：事件归并 reducer（`UIEntry` 模型，`stream_event` → 累积 partial → 完成）
- [x] 消息卡：user / assistant / thinking / image / tool_use（按工具名映射图标） / tool_result / system_init（含 mcp_servers/tools/skills/slash_commands 折叠展开） / system_status / result（cost/duration/turns） / rate_limit / stderr / raw / unknown
- [x] 图片粘贴/拖拽 → base64 image block
- [x] Esc 中断
- [x] 收集真实事件样本（`doc/stream-json-1.txt`）+ schema 文档（`doc/events.md`）
- [x] UI 框架重构为 shadcn/ui + Tailwind v4（12 个 primitives：button / card / badge / scroll-area / separator / textarea / input / label / dialog / tooltip / collapsible / sonner）
- [x] 工作目录 Workspace 选择对话框（`@tauri-apps/plugin-dialog` 浏览 / 路径输入 / 不存在自动 `create_dir`）
- [x] Rust 新增命令：`create_dir` / `path_exists` / `default_workspace_root` / `list_dir`
- [x] React 18 → 19 升级（避免 shadcn primitives 写 forwardRef 模板代码）
- [x] 主题系统：light（Claude 暖橙色调，默认）/ dark / system 三档；`ThemeProvider` + `useTheme` + `localStorage["claudecli.theme"]` + `index.html` 内联 FOUC 防抖脚本
- [x] codex 风左侧 Sidebar：项目列表（`localStorage["claudecli.projects"]`）+ 搜索 + 新对话 + 添加项目（`Ctrl+O`）+ 设置；首启不再强制弹窗
- [x] Welcome 页：无项目时引导添加；有项目时居中标题 + 大圆角 Composer + 常用提示按钮（点击预填到输入框）
- [x] `SettingsDialog`：主题三档切换（占位扩展自定义主色）
- [x] `WorkspaceDialog` → 重构为 `AddProjectDialog`，仅作"添加项目"用
- [x] 修复 reducer streaming bug（`reduceAssistant` 命中已有 streaming UIMessage 时不再提前关 streaming，等 `message_stop`；之前导致流式中途消息丢失，UI 显示空白）
- [x] 修复 empty 布局 bug（Welcome 不再 `flex-1`，让父容器决定布局；Composer 不再被推出可视区）
- [x] sonner toast 居中（`position="top-center"` + 主题跟随 `useTheme`）
- [x] 真实事件优化卡片（基于 `doc/stream-json-2.txt`）：`tool_use_result` 顶级字段附着到 tool_result block；按 `type` 分流 —— `text+file` 显示 Read 内容预览 / `create` 显示 Write 新建 + 内容 / `update + structuredPatch` 渲染 diff（按 hunk +/- 着色）
- [x] tool_use 卡片智能字段：`file_path` 单行显示 / `command` 终端样式 / `description` 注释样式
- [x] **消息渲染 codex 风重构**：去掉 USER/ASSISTANT 标签 + 卡片包裹
  - user → 右对齐 muted 圆角气泡
  - assistant text → 左对齐裸文本（无卡片）
  - thinking → 折叠 `[chevron] 思考过程`，partial 时默认展开
  - tool_use → 单行 `[icon] 已运行 git status --short`（partial 显示"正在运行"+ spinner），点击展开看完整 input
  - tool_result → 单行 `读取 18 行 README.md` / `更新 file.ts · +5 -3` / `已创建` 等，按 `tool_use_result.type` 分流，展开看 diff/内容
  - system_init → 折叠详情，默认关闭
  - `system_status` / `rate_limit_event` → 不渲染（背景信息，噪音）
  - result → 简洁 chip 行 `✓ 完成 $0.1796 3.09s 1 turn`
- [x] **textarea 滚动按钮去掉**：`scrollbar-thin` utility 加 `::-webkit-scrollbar-button { display: none }`，Textarea 默认应用，全局 textarea/pre 兜底
- [x] **消息布局对齐修复**：MessageView 不再强制 `items-end`；BlockView 内部各自决定对齐——TextBlock(user) 自身 `self-end` 气泡，其他 block（thinking/tool_use/tool_result/image）一律左对齐 `self-start`，避免点开 tool 时整行从右向左跳。
- [x] **展开/折叠平滑动画**：`grid grid-rows-[0fr → 1fr] transition-[grid-template-rows] duration-200` 替代瞬跳；`ChevronRight transition-transform`。
- [x] **tool_use 展开内容按工具分流**（不再 dump 整个 input JSON）：
  - Bash/PowerShell：description（斜体）+ command 代码块
  - Write：filePath chip + content 代码块
  - Edit：filePath + replace_all chip + 移除（红）/ 新增（绿）双 pre
  - MultiEdit：每条 edit 编号 + 移除/新增
  - Read：filePath + offset/limit
  - Grep/Glob：键值列表
  - 其他：JSON dump（兜底）
- [ ] 用户实测 `pnpm tauri dev` 跑一轮真实对话验证流式渲染（待用户跑）
- [ ] Bash 终端样式美化（ANSI 着色 + stdout 折叠，留 P4）

### P1：会话管理（1.5 周）

- [x] Rust：扫描 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`（按需读取，不建 sqlite，简化）
- [x] Rust：`list_project_sessions(cwd) → SessionMeta[]`（id / mtime / size / msg_count / aiTitle / firstUserText，按 mtime 倒序）
- [x] Rust：`read_session_transcript(cwd, sessionId) → Value[]`（jsonl 行解析返回）
- [x] Rust：`spawn_session` 加 `resume_session_id` 参数，透传 `--resume <id>`
- [x] 前端：Sidebar 项目下嵌套展开 sessions（aiTitle 优先 / 首条 user text fallback / 相对时间）
- [x] 前端：选中历史 session 加载只读 transcript（reducer `load_transcript` action + 过滤 jsonl 内部事件 queue-operation/attachment/ai-title/...）
- [x] 前端：发送新消息时自动 `--resume` 现有 session，新事件追加到现有 transcript
- [x] 顶部 header：项目名 + resume/active 双 badge + cwd 路径
- [ ] notify watcher 增量更新（暂用按需懒加载，性能足够）
- [ ] 独立的 Sessions 全屏视图（搜索 / 筛选 / 排序 / 分组）—— 现按 Sidebar 嵌套替代，必要时再做
- [ ] fork session（`--fork-session` 命令暴露给 GUI）
- [ ] 删除 jsonl 文件（带二次确认）

### P2：参数与 diff（1 周）

- [ ] 前端：右栏 Context Panel（model/effort/perm/cost/budget/add-dir/mcp）
- [ ] 切换参数透传到下次发送
- [ ] Edit/Write diff（CodeMirror merge view）
- [ ] 斜杠命令面板（候选来自常用列表 + 用户历史）
- [ ] @ 文件补全

### P3：设置页（codex 风全页，独立路由）

> 替代当前 `SettingsDialog`，做成全屏多分类页面。
> 左侧导航 + 右侧详情，分类参考 codex desktop。

#### P3.1 常规

- [ ] 启动行为（启动时自动恢复上次 project / 默认新对话）
- [ ] 关闭行为（kill 进程确认 / 后台保留）
- [ ] 自动检查更新

#### P3.2 外观（核心，分浅色/深色双套独立配置）

- [x] 主题切换：light / dark / system（迁移到此页）
- [x] **强调色**（accent / primary）：颜色选择器 + hex 输入，写入 `--primary` / `--ring`
- [x] **背景色**（background）：颜色选择器 + hex 输入
- [x] **前景色**（foreground）：颜色选择器 + hex 输入
- [x] **UI 字体**：自定义 family（input，写 `font-family` on `<html>`）
- [x] **代码字体**：自定义 mono family（写 `--font-mono`）
- [x] **半透明侧栏**：自定义 Switch（`role="switch"`），写 `--sidebar: transparent`
- [x] **对比度滑块**：range 0-100（数值已存储，应用逻辑待 P4 细化）
- [x] **预设主题集**：内置 Claude（默认 = 清空覆盖）/ Codex / Absolutely，预览 4 色圆点
- [x] 每套主题独立"重置"按钮 + 顶部"全部重置"
- [x] 实时生效（`applyAppearance` 直接写 CSS 变量，无需刷新）
- [ ] 实时预览面板（左侧 codex 风 diff 预览，可选增强）
- [ ] 自定义主题命名 / 导入 / 导出 JSON

#### P3.3 配置

- [ ] 默认 model（下拉，可标注成本）
- [ ] 默认 effort（low/medium/high/xhigh/max）
- [ ] 默认 permission_mode（default/acceptEdits/plan/bypassPermissions）
- [ ] 默认 max-budget-usd
- [ ] CLAUDE_CLI_PATH 覆盖
- [ ] 默认 add-dir 列表

#### P3.4 个性化

- [ ] 系统提示扩展（`--append-system-prompt`）
- [ ] 默认 agents（`--agents` JSON 编辑器）
- [ ] 自定义 slash 快捷面板（高频命令 pin）

#### P3.5 MCP 服务器

- [ ] 列表：从 `system/init.mcp_servers` 读取 + 配置文件解析
- [ ] 启用 / 禁用 toggle
- [ ] 状态：connected / needs-auth / failed（连过去看）
- [ ] 添加/编辑（写入 `~/.claude/mcp.json` 或本项目 `.claude/mcp.json`）
- [ ] needs-auth 走 OAuth 流程（如 Google Drive）

#### P3.6 Git

- [ ] 默认 commit signing toggle
- [ ] 默认 base branch
- [ ] 自动 fetch 频率

#### P3.7 环境

- [ ] 环境变量列表（覆盖给 claude 子进程）
- [ ] PATH 追加

#### P3.8 工作树

- [ ] 默认 worktree 根目录
- [ ] 自动清理已合并

#### P3.9 浏览器使用

- [ ] 内置 playwright MCP 默认开关
- [ ] 默认 viewport 尺寸

#### P3.10 已归档对话

- [ ] 列出归档的 sessions（暂不实现 archive 行为）

#### P3.11 账号 / Usage（顶部独立区）

- [ ] 显示登录方式：API key（环境变量）/ OAuth（Anthropic）/ Bedrock / Vertex / Foundry
- [ ] 登出 / 重新登录
- [ ] **Usage 面板**：
  - 当前 5h / 1h / weekly 限额（来自 `rate_limit_event`）
  - 累计成本（按 model 拆分）
  - 当前会话 cost / token
  - 数据源：result.modelUsage + 累计 localStorage 持久化

#### P3.12 网络 / 代理（全局生效）

- [x] 协议：HTTP / HTTPS / SOCKS5 / SOCKS5h
- [x] 主机 / 端口 / 用户名 / 密码（密码 show/hide 切换；当前明文 localStorage，**待加 keychain 升级**）
- [x] 例外列表（`NO_PROXY`，逗号分隔，默认 `localhost,127.0.0.1,::1`）
- [x] 实施：`spawn_session` 加 `env` 参数，前端 `buildProxyEnv` 拼装 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / 小写别名 / `NO_PROXY`，Rust `Command::env(k, v)` 注入子进程
- [x] 应用范围：仅 claude 子进程（已运行的不影响，下次启动生效）
- [x] 配置预览：`http://user@host:port` 实时显示
- [x] 启用 toggle + 保存按钮（仅在 dirty 时启用）
- [ ] 全应用范围（含 webview）：Tauri 2 暂未公开稳定的 setProxy API，留 P4
- [ ] PAC URL 支持
- [ ] 测试连接按钮（spawn `curl --proxy ...` 或 reqwest 验证）—— 留 P4
- [ ] 密码 OS keychain 加密存储（`@tauri-apps/plugin-stronghold`）

### P4（按需）

- [ ] 多标签会话
- [ ] hooks 编辑器
- [ ] `--from-pr` 关联
- [ ] checkpoint 时间线
- [ ] 自定义 agents 注册
- [ ] @ 文件补全 + / 斜杠面板
- [ ] Bash 终端样式美化（保留输出折叠 + ANSI 着色）

---

## 7. 事件流验证（已完成 P0 主线）

| 资料                       | 路径                    |
| -------------------------- | ----------------------- |
| 第一份真实样本（普通对话） | `doc/stream-json-1.txt` |
| schema 摘要 + 处理策略     | `doc/events.md`         |

**未来需要补样本的场景**：`permission_request` / `hook_event` / subagent 嵌套 / 长 tool_result / 错误路径 / Bash 长运行。每补一个样本就在 `doc/events.md` 对应章节追加字段表。

---

## 8. 主要风险与处理

| 风险                    | 处理                                                 |
| ----------------------- | ---------------------------------------------------- |
| stream-json schema 漂移 | 适配层 + unknown fallback；锁 CLI minor 版本上限提示 |
| Windows pipe + UTF-8    | tokio::process + 显式 utf-8 codec；stderr 独立       |
| 权限请求事件未公开      | P0 跑 `acceptEdits` 验证主流程；P2 再做交互式权限    |
| CLI 可执行路径定位      | which / 注册表 / 用户设置覆盖；首启向导              |
| 子进程僵死              | 心跳超时 + force kill + 重新 spawn 用 --resume       |
| jsonl 大文件            | reader 用尾读 + 流式解析，不全量加载                 |

---

## 9. 不做清单（明确边界）

- 团队协作 / 多人共享会话
- 云同步 / 远程会话
- 自研工具 / 工具市场
- 嵌入浏览器（除非通过 CLI 自带 MCP）
- 自研 agent loop / prompt
- 重新实现 skills / hooks 逻辑（仅 GUI 化配置）

---

## 10. 当前进度快照（2026-04-29 · 续三）

- ✅ P0 骨架完成（tsc 无错 / vite build 1852 modules / cargo check 通过）
- ✅ 事件归并 reducer + 真实样本（`doc/stream-json-1.txt` + `doc/stream-json-2.txt` 含 thinking / Write / Read / structuredPatch）
- ✅ UI 框架：shadcn/ui + Tailwind v4 + React 19 + 路径别名 `@/*`
- ✅ 主题系统：light（Claude 暖橙调，默认）/ dark / system；FOUC 防抖；SettingsDialog 切换（占位，P3 升全页）
- ✅ codex 风布局：左 Sidebar（项目列表 + 搜索 + 新对话 + 设置）+ 主区（Welcome 居中 / 流式视图 / Composer 双形态）
- ✅ 项目持久化：localStorage["claudecli.projects"]
- ✅ Tauri dialog plugin + 4 个 fs/dialog 命令
- ✅ **bug 修复**：reducer streaming 提前关闭、Welcome 抢空间、sonner 位置
- ✅ **tool_result 卡片**：按 `tool_use_result.type` 分流（read 内容预览 / create 新建 / update 渲染 structuredPatch diff）
- ✅ **P1 历史会话**：Rust `list_project_sessions` + `read_session_transcript` + `spawn` 加 `--resume`；前端 Sidebar 项目下嵌套展开 sessions（aiTitle 标题 / 相对时间）；reducer `load_transcript` action 过滤 jsonl 内部事件
- ✅ **消息渲染 codex 风重构**：user 气泡 / assistant 裸文本 / thinking 折叠 / tool_use+tool_result 单行 + 展开
- ✅ **textarea 滚动按钮修复**：webkit scrollbar-button 隐藏
- ✅ **P3 设置页骨架完成**：全屏 Dialog + 12 分类左导航
- ✅ **P3.2 外观完整**：主题 / 预设 / 浅色深色双套 6 项独立配置 / 实时生效
- ✅ **P3.12 网络代理**：HTTP/HTTPS/SOCKS5/SOCKS5h + 用户名密码（show/hide）+ NO_PROXY + 子进程 env 注入
- ✅ **消息渲染细节修复**：对齐归位（tool 行不再随 user 右对齐）+ grid 行高动画（展开丝滑）+ tool_use 展开按工具分流（Write 显示 content / Edit 显示移除·新增双侧 / 不再 dump 原始 JSON）
- ⏳ 待用户实测 `pnpm tauri dev`
- ⏳ P3 其他分类：配置 / 个性化 / MCP / Git / 环境 / 工作树 / 浏览器 / 归档 / 账号Usage（占位）

---

## 11. 给其他 Agent（codex / 接手开发者）的快速实施清单

> 当 codex / 其他 agent 接手时，只需读 plan.md + `doc/events.md` 即可开干。
> 不要重读源码全量去理解架构 —— 这一节就是导航。

### 11.1 关键不变量（破坏即回滚）

1. **桌面端不解析 prompt / 工具语义** —— 只渲染。所有 agent 行为由 CLI 自己负责，桌面端是 UI shell。
2. **未知事件不丢弃** —— `reducer.ts` 必须保留 `UIUnknown` fallback 路径。
3. **transcript 不重复存储** —— P1 索引读 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`，桌面端 SQLite 仅做元数据缓存，jsonl 是单一事实源。
4. **CLI 调用参数集中** —— 在 `src-tauri/src/proc/manager.rs::Manager::spawn` 拼装；新增参数加到 `SpawnOptions` struct，不要散布。
5. **事件透传不强类型** —— Rust 侧用 `serde_json::Value`，前端用 reducer 容错。

### 11.2 关键入口文件

| 路径                                  | 职责                                                |
| ------------------------------------- | --------------------------------------------------- |
| `plan.md`                             | 总规划                                              |
| `doc/events.md`                       | stream-json schema                                  |
| `doc/stream-json-1.txt`               | 真实事件样本                                        |
| `src-tauri/src/proc/manager.rs`       | 子进程 spawn / stdin 写入 / stdout 解析 / 事件 emit |
| `src-tauri/src/proc/spawn.rs`         | claude CLI 路径定位（支持 `CLAUDE_CLI_PATH` 覆盖）  |
| `src-tauri/src/commands.rs`           | Tauri command 暴露给前端                            |
| `src-tauri/src/error.rs`              | 统一 Error + serde 序列化                           |
| `src-tauri/tauri.conf.json`           | 窗口 / bundle / identifier                          |
| `src-tauri/capabilities/default.json` | Tauri 2 权限                                        |
| `src/lib/ipc.ts`                      | Tauri command typed wrapper                         |
| `src/lib/reducer.ts`                  | 原始事件 → UI 模型归并                              |
| `src/types/events.ts`                 | 原始 ClaudeEvent 宽松类型                           |
| `src/types/ui.ts`                     | UI 模型（`UIEntry` discriminated union by `kind`）  |
| `src/components/MessageCard.tsx`      | 按 `entry.kind` / `block.type` 分发渲染             |
| `src/components/MessageStream.tsx`    | 自动滚底 + 空状态                                   |
| `src/components/Composer.tsx`         | 文本 / 图片 / Esc / Send-Stop                       |
| `src/App.tsx`                         | useReducer + 会话生命周期                           |

### 11.3 Tauri 事件协议

- `claude://session/<id>/event` —— `serde_json::Value`，每行 stream-json 解析后；非 JSON 行包成 `{type:"raw", line}`。
- `claude://session/<id>/error` —— `string`，stderr 一行。

### 11.4 Tauri commands

| 名字                | 入参                                    | 返回          | 调用文件                          |
| ------------------- | --------------------------------------- | ------------- | --------------------------------- |
| `detect_claude_cli` | —                                       | `string` 路径 | `src/lib/ipc.ts::detectClaudeCli` |
| `spawn_session`     | `cwd, model?, effort?, permissionMode?` | `session_id`  | `spawnSession`                    |
| `send_user_message` | `sessionId, contentBlocks`              | `void`        | `sendUserMessage`                 |
| `stop_session`      | `sessionId`                             | `void`        | `stopSession`                     |

### 11.5 添加新工具卡片（高频任务）

1. `MessageCard.tsx::toolIcon(name)` 加映射（如 `WebFetch → Globe`）。
2. 如需自定义渲染（不只是 JSON dump），在 `BlockView` 的 `tool_use` 分支按 `block.toolName` 分流。
3. **不要改 reducer** —— 它对工具名无感知，只搬运 `name`/`input`。

### 11.6 添加新事件类型

1. `src/types/ui.ts` 加新的 `UI*` 接口，并入 `UIEntry` union（必须有 `kind` 字段做 discriminator）。
2. `src/lib/reducer.ts::reduceEvent` 加分支。
3. `MessageCard.tsx` 顶层 if 加渲染。
4. 如 Rust 侧需要预处理（罕见），改 `src-tauri/src/proc/manager.rs` 的 stdout reader。

### 11.7 新增 Rust command

1. `src-tauri/src/commands.rs` 加 `#[tauri::command]` 函数。
2. `src-tauri/src/lib.rs::run` 的 `tauri::generate_handler!` 注册。
3. `src/lib/ipc.ts` 加 typed wrapper。
4. 如需共享状态，加到 `proc::Manager` 或新建 manager 用 `app.manage(...)` 注入。

### 11.8 跑通环境检查（CI 友好）

```bash
pnpm install
pnpm exec tsc --noEmit         # 前端类型检查
pnpm build                     # 前端 vite build
cd src-tauri && cargo check    # Rust 编译（不打包）
pnpm tauri dev                 # 启动桌面 dev 窗口（需要 GUI）
pnpm tauri build               # 打包安装包（首次较慢）
```

### 11.9 P1 切入点（codex 优先做）

1. 新建 `src-tauri/src/session/{mod,index,reader,watcher}.rs` —— 实现 jsonl 索引（schema 见 §2.2）。
2. `src-tauri/src/commands.rs` 加：`list_sessions(filter, sort)` / `resume_session(id)` / `fork_session(id)` / `delete_session(id)` / `read_session(id, offset, limit)`。
3. spawn 时传 `--resume <id>` / `--fork-session` 透传。
4. 前端新建 `src/components/Sessions/`：列表项 / 搜索框 / 筛选下拉 / 排序切换。
5. 整体布局改为三栏（左 Sessions / 中 Stream / 右 Context），调整 `App.tsx` 的 grid。
6. **不要改 P0 流式渲染逻辑** —— 复用现有 `App.tsx` 的 reducer 流。

### 11.10 P2 切入点

1. `src/components/ContextPanel/`：model / effort / permission_mode / cost / budget。
2. `tool_use: Edit/Write` 渲染：把 `block.toolInput` 的 old_string/new_string 用 CodeMirror merge view 渲染 diff（`@uiw/react-codemirror` + `@codemirror/merge`）。
3. `tool_use: Bash` 终端样式：等宽字体 + 黑底 + cmd 高亮 + stdout 折叠。
4. Composer 加 `/` 斜杠面板（候选来自 `system/init.slash_commands`）+ `@` 文件补全（新 Rust command `list_files(cwd, prefix)`）。

### 11.11 已知风险与处理（要点）

| 风险                    | 当前处理                             | 待加强                                      |
| ----------------------- | ------------------------------------ | ------------------------------------------- |
| stream-json schema 漂移 | reducer fallback + UIUnknown         | P3 加 schema 版本告警                       |
| 权限请求事件未样本化    | `--permission-mode acceptEdits` 旁路 | 拿到 `permission_request` 样本后做 GUI 弹窗 |
| 子进程僵死              | `kill_on_drop = true` + `start_kill` | P3 加心跳超时                               |
| Windows 字符编码        | tokio + utf8 默认                    | 遇问题加 explicit decoder                   |
| jsonl 大文件（P1）      | —                                    | reader 用尾读 + 增量                        |

### 11.12 shadcn/ui + Tailwind v4 集成约定

- **路径别名**：`@/*` → `src/*`，定义在 `vite.config.ts`（`fileURLToPath`）+ `tsconfig.json`（`paths`）。
- **样式入口**：`src/index.css` 使用 `@import "tailwindcss"` + `@theme inline`，dark 主题默认。颜色变量集中在 `:root`（暗）/ `.light`（亮）。
- **shadcn 配置**：`components.json`，style=`new-york`，baseColor=`neutral`，alias=`@/components/ui`。
- **新增 primitive**：手写到 `src/components/ui/<name>.tsx`。结构：`function Foo({className, ...props}: React.ComponentProps<"...">)`，加 `data-slot` 标记，用 `cn(...)` 合并 classes。**React 19 不需要 `forwardRef`** —— ref 自动作为 prop forward。
- **追加 shadcn 组件**：可用 `pnpm dlx shadcn@latest add <name>`（已配置 `components.json`），或对照官方 new-york 风格手写。
- **图标**：`lucide-react`，全部 named import。Button / Badge 内部 CSS 有 `[&_svg]:size-…` 控制尺寸，无需手动设。
- **toast**：`sonner`，根组件 `<Toaster />` 在 `App.tsx`，业务里 `import { toast } from "sonner"`。
- **自定义颜色**：`--color-user / --color-thinking / --color-tool / --color-connected / --color-warn` 在 `index.css` 的 `@theme inline` 暴露为工具类（如 `bg-user`、`border-warn/40`）。新增按此模式扩展。
- **滚动**：长列表用 `<ScrollArea>`（Radix），需要程序式滚动到底用 `el.querySelector("[data-slot='scroll-area-viewport']")`。

### 11.13 工作目录（Workspace）流程

- **Rust 命令**：`default_workspace_root`（返回 `<home>/claude-projects`）/ `path_exists` / `create_dir`（递归）/ `list_dir`（目录优先排序，跳过 dotfiles）。
- **前端**：`WorkspaceDialog` 用 `@tauri-apps/plugin-dialog::open({directory:true})` 打开系统文件夹选择，也允许直接编辑路径，不存在则 `create_dir` 自动创建。
- **切换工作目录** = 先 `teardown` 当前会话（kill 子进程 + 取消 listener）→ `dispatch({kind:"reset"})` 清空 UI → 设新 cwd → 下次发送时 `ensureSession` 用新 cwd `spawn_session`。
- **首启**：`App` 监测 `cwd` 为空时自动弹出 `WorkspaceDialog`。
- **Capability 要求**：`src-tauri/capabilities/default.json` 必须含 `dialog:default` + `dialog:allow-open`。
- **不要做的**：不要在前端用 `window.prompt` / `alert` —— Tauri webview 行为不一致；统一走 shadcn `Dialog` + sonner `toast`。

### 11.14 关键依赖版本（2026-04-29 锁定）

| 包                         | 版本   |
| -------------------------- | ------ |
| react / react-dom          | 19.2.5 |
| @tauri-apps/api            | 2.10   |
| @tauri-apps/plugin-dialog  | 2.7    |
| @tauri-apps/cli            | 2.10   |
| tailwindcss                | 4.2    |
| @tailwindcss/vite          | 4.2    |
| lucide-react               | 1.14   |
| vite                       | 5.4    |
| typescript                 | 5.9    |
| tauri (rust)               | 2.x    |
| tauri-plugin-dialog (rust) | 2      |
| dirs (rust)                | 5      |

### 11.15 主题系统约定

- **默认 light**，使用 Claude 官方暖橙色调：背景 `oklch(0.98 0.005 95)`（≈ #faf9f5）、主色 `oklch(0.66 0.13 40)`（≈ #d97757，Claude orange）。
- **dark** 保留中性灰底 + 暖橙主色。
- **theme key**：`localStorage["claudecli.theme"]`，值 `"light" | "dark" | "system"`。
- **应用方式**：`document.documentElement.classList` 维护单一 class（"light" 或 "dark"），由 `ThemeProvider` 监听 `theme + system` 解析。CSS 中 `:root, .light { ... }` 与 `.dark { ... }` 并存。
- **FOUC 防抖**：`index.html` 顶部内联 `<script>` 在 React 加载前根据 localStorage 设置 class，避免初始闪烁。
- **新增 token**：往 `index.css` 的 `:root, .light` + `.dark` + `@theme inline` 三处同步加变量，类名形式 `bg-<name>` / `text-<name>` 自动可用（如 `bg-sidebar`、`text-warn`）。
- **Sidebar 专用色**：`--sidebar / --sidebar-foreground / --sidebar-muted / --sidebar-border / --sidebar-accent`，与主区背景区分。
- **未来扩展**：`SettingsDialog` 留了"自定义主色"的位置，下一步可加颜色选择器写入新 token，覆盖 `--primary` / `--ring`。

### 11.17 历史会话 / Transcript 架构

- **数据源**：CLI 自己写的 jsonl，路径 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`。
- **cwd 编码规则**：`encode_cwd(cwd) = cwd.chars().map(c => c.is_alphanumeric() || c == '-' ? c : '-').collect()`。例：`F:\project\claude-test` → `F--project-claude-test`。**连续 `-` 不压缩**。
- **jsonl 行级 type**：与 stream-json 类似但有差异，至少包含：
  - `user` / `assistant`：与 stream-json 一致，可直接喂 reducer
  - `queue-operation`：内部排队，过滤
  - `attachment`：附件（含 `attachment.type` 子类，如 `deferred_tools_delta` / `skill_listing`），过滤
  - `ai-title`：AI 自动生成的会话标题，元数据用，过滤
- **元数据提取**（`scan_jsonl`）：
  - `aiTitle`：来自 `ai-title` 行的 `aiTitle` 字段
  - `first_user_text`：第一个 `type:"user"` 行的 `message.content[0].text`
  - `msg_count`：仅 `user` / `assistant` / `message` 行
  - `modified_ts`：文件 mtime
- **加载策略**：`reducer.ts::load_transcript` 一次性吞所有事件，过滤 `queue-operation` / `attachment` / `ai-title` / `deferred_tools_delta` / `skill_listing` 后逐条 reduce，最后强制 `streaming = false`。
- **恢复进程**：用户在已加载 transcript 上发送新消息时，`ensureSession` 调 `spawn_session({ ..., resumeSessionId: selectedSessionId })`，CLI 透传 `--resume <id>`，新事件追加到现有 transcript。
- **资源**：未实现 fs watcher / sqlite 索引，按需 lazy load 项目下 sessions。性能上一个项目几十个 session 没问题；超过几百时 P4 升级 sqlite + watcher。
- **Sidebar 加载**：项目展开时（`toggleExpand`）懒加载 sessions；`selectedProjectId` 变化时自动展开 + 加载。
- **不实现的**：fork（`--fork-session`）/ 删 jsonl 文件 —— P1 内可补，未做。

### 11.18 P3 设置页骨架（给 codex 接手）

实施这一节前先读 §6 P3 子节的全部条目，确定优先级。骨架建议：

- 文件结构：
  - `src/components/Settings/index.tsx` —— 入口（路由或全屏 Dialog）
  - `src/components/Settings/Sidebar.tsx` —— 左导航
  - `src/components/Settings/sections/{General,Appearance,Config,Personalization,Mcp,Git,Env,Worktree,Browser,Archive,Account,Network}.tsx` —— 每个分类一文件
- 状态：复用 `localStorage` + 新加 `claudecli.settings.*` 命名空间；敏感字段（代理密码、API key）走 OS keychain（`@tauri-apps/plugin-stronghold` 或 Tauri 2 secure-storage）。
- 主题色自定义：扩展 `index.css` 的 `--primary` / `--background` / `--foreground` 等，新增 token 后从 `Settings/sections/Appearance.tsx` 直接 `document.documentElement.style.setProperty("--primary", value)`。
- 代理：
  - 写 `localStorage["claudecli.proxy"] = { protocol, host, port, user, pass, noProxy }`
  - `proc::manager::spawn` 启动子进程时注入 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` 环境变量
  - 桌面 webview 走 `WebviewWindow.setProxy`（需要 Tauri 2 capability `core:webview:setProxy`）
- Usage：从 reducer 累加 `result.modelUsage` + `rate_limit_event.rate_limit_info` 形成全局 store；持久化到 localStorage 按日聚合。
- 登录方式探测：从 `system/init.apiKeySource` 读取（none / env / oauth / bedrock / vertex / foundry），不需要单独 API。
- 不要重做主题切换基础——已有 `ThemeProvider`，扩展即可。

### 11.16 Sidebar / Projects / Welcome 架构

- **Project 模型**（`src/lib/projects.ts`）：`{id, cwd, name, lastUsedAt}`，存 `localStorage["claudecli.projects"]`，按 lastUsedAt 倒序。
- **同 cwd 去重**：`addProject(cwd)` 命中已有项目时只刷新 `lastUsedAt`。
- **首启 UX**：不强制弹任何对话框；Sidebar 显示"暂无项目"提示，主区 Welcome 显示"添加项目"大按钮。
- **添加路径**：Sidebar `+` 按钮 / `Ctrl+O` / Welcome "添加项目" 按钮 → `AddProjectDialog`（路径输入 + plugin-dialog 浏览 + 不存在自动 `create_dir`）。
- **切换项目**：`teardown` 当前会话 → `dispatch({kind:"reset"})` 清空消息 → 设新 `project` → 下次发送时 `ensureSession` 用新 cwd `spawn_session`。
- **Composer 双形态**：`centered` prop 控制——empty 状态居中、圆角卡片样式；有消息后回到底部、border-top 紧贴模式。两种形态下输入逻辑完全一致。
- **建议预填**：Welcome 上点击建议项 → `setDraft(s)` → Composer 通过 `externalText` prop 拿到 → 填入 textarea + 焦点（用户可改后再发）。
- **P1 切入点（codex 接手）**：在 Sidebar 项目下展开"最近会话"，数据来自 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` 索引；`onSelect` 改为 `(project, sessionId?)` 携带恢复目标，`spawn_session` 调用时传 `--resume <id>`。
