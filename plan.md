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

#### P3.4 个性化（对齐 Claude Code 已有能力，**不照搬 Codex**）

> 仅暴露 Claude Code 真有的入口，未实现的能力（如 Codex 风「记忆 / 跳过工具辅助对话 / 重置记忆」）一律不做占位。
> 参考：`~/.claude/CLAUDE.md`（global） + `<cwd>/CLAUDE.md`（project） + `<cwd>/.claude/CLAUDE.local.md`（local，被 git 忽略）。

- [ ] **自定义指令（CLAUDE.md）**
  - 三个 scope：global / project / project-local，对应文件路径见上
  - UI：textarea（mono 字体，行号可选）+ scope 切换 tab + 「保存」按钮（dirty 才启用）
  - 使用 `read_claude_settings(scope, cwd?)` 模式扩展 `read/write_claude_md(scope, cwd?)` Rust 命令；不存在文件时 read 返回空串
  - 顶部链接「了解更多」指向 Anthropic 官方文档
  - **不做** 记忆系统（Claude Code 没有 Codex 那种 memory toggle，能力由 CLAUDE.md 一站式覆盖）
- [ ] 高频命令 pin：从 `system/init.slash_commands` 列表勾选，写 `claudinal.settings.pinnedSlash`，Composer `/` 面板顶部置顶展示
- [ ] **不做** `--append-system-prompt`、`--agents` JSON 编辑器：保持 CLAUDE.md 一条路径，避免 prompt 来源分裂

#### P3.5 MCP 服务器（参考 Codex UI 形态，但写入 Claude 原生 mcp.json）

> 列表页 + 详情编辑页双视图（用 Breadcrumb 在页内导航：`MCP 服务器 > playwright > 编辑`）。
> 配置文件：用户级 `~/.claude/mcp.json`，项目级 `<cwd>/.mcp.json`（Claude Code 文档约定）。

- [ ] **列表视图**
  - Header：「MCP 服务器」标题 + 副标题「连接外部工具和数据源」+ 右上「+ 添加服务器」
  - 行卡片：服务器名 / 状态点（来自 `system/init.mcp_servers`：connected / needs-auth / failed）/ 齿轮按钮跳详情 / 启用 toggle
  - 数据源合并：`system/init.mcp_servers` 状态 + 解析两份 mcp.json 配置；以配置文件为权威来源
- [ ] **详情/编辑视图**
  - 顶部 Breadcrumb「← 返回 MCP 服务器 > {name}」+ 右上「卸载」红按钮（移除该服务器条目）
  - 类型切换 tab：`STDIO` / `流式 HTTP`（对应 Claude Code mcp.json 的 `type: "stdio" | "http"`）
  - STDIO 字段：名称 / 启动命令（command）/ 参数（args[]，每行一个 + 删除按钮 + 「+ 添加参数」）/ 环境变量（key-value 对，「+ 添加环境变量」）/ 环境变量传递（envPassthrough[]，从父进程透传名）/ 工作目录（cwd）
  - HTTP 字段：名称 / URL / headers（key-value）/ 鉴权方式（none / bearer / oauth）
  - 「保存」按钮 dirty 才启用，原子写 mcp.json
- [ ] needs-auth 走 OAuth：状态点提示，点击触发对应 server 的 OAuth flow（保留为 P4）
- [ ] **scope 选择**：保存时让用户选 global（`~/.claude/mcp.json`）或 project（`<cwd>/.mcp.json`）

#### P3.6 Git

- [ ] 默认 commit signing toggle
- [ ] 默认 base branch
- [ ] 自动 fetch 频率

#### P3.7 环境（**项目级运行环境，参考 Codex 设计**）

> 不再是简单的「全局环境变量列表」，而是按项目挂载工作树构建/清理脚本。命名沿用 Codex 的「环境」二级菜单。
> 入口结构：`环境 > 选择项目 > {项目名} > 编辑`，用 Breadcrumb 显示完整路径。

- [ ] **项目列表视图**
  - Header「环境」+ 副标题「本地环境用于指示 Claude 如何为项目设置工作树」+ 右上「添加项目」按钮（复用 `AddProjectDialog`）
  - 行：folder 图标 + 项目名 +（可选）短标签 + 右侧「+」加号点击进入编辑视图
- [ ] **项目环境编辑视图**
  - Breadcrumb：`← 返回 / 环境 / {项目名} / 编辑`
  - 「本地环境」只读卡：项目名 + 完整 cwd
  - 「名称」input：默认值 = 项目 basename，可改（写入 project store 的 `name` 字段）
  - 「设置脚本」textarea + 平台 tab（默认 / macOS / Linux / Windows，每平台独立脚本）+ 右上「变量」hint（说明 `$CLAUDINAL_WORKTREE_PATH` 占位）—— 创建工作树时在项目根目录下运行
  - 「清理脚本」textarea + 平台 tab —— 清理工作树之前在项目根目录下运行
  - 「操作」分区：可添加任意命令到工具栏（待 P4，先占位「添加操作」按钮 + 提示文案）
  - 「保存」按钮 dirty 才启用
  - 存储：`localStorage["claudinal.project-env"][projectId] = { name?, setupScripts: { default?, macos?, linux?, windows? }, cleanupScripts: {...}, actions: [] }`
- [ ] 工作树自动化（创建 / 清理 / 派生）放到 §9.1.1「派生到新工作树」一并实施，本节只暴露脚本配置入口
- [ ] **不做** 全局 PATH 追加 / 全局 env 列表 —— 这部分由 settings.json env 字段直接编辑，已在 P3.3 移除（避免 OAuth 冲突）

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

**未来需要补样本的场景**：`control_request` 权限流 / `hook_event` / subagent 嵌套 / 长 tool_result / 错误路径 / Bash 长运行。每补一个样本就在 `doc/events.md` 对应章节追加字段表。

---

## 8. 主要风险与处理

| 风险                    | 处理                                                 |
| ----------------------- | ---------------------------------------------------- |
| stream-json schema 漂移 | 适配层 + unknown fallback；锁 CLI minor 版本上限提示 |
| Windows pipe + UTF-8    | tokio::process + 显式 utf-8 codec；stderr 独立       |
| 权限请求 GUI 接管       | `--permission-prompt-tool stdio` 控制协议；保留 `permission_denials` 显式兜底 |
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

## 9.1 待办：尚未完成的功能（来自 2026-04-30 用户反馈）

> 已实现见 §10 进度快照。此处列出 **明确知道还没做** 的事项，按优先级排序。
> 接手者直接对照本节挑任务即可。

### 9.1.1 Sidebar / 会话项交互

- [x] **重命名会话**：`src/lib/sessionTitles.ts`（`localStorage["claudinal.session-titles"]`），`RenameSessionDialog` Dialog；ChatHeader 下拉菜单 onRename 触发；Sidebar `SessionRow` 显示时优先读 `getSessionTitle(session.id)`，留空恢复默认。
- [x] **删除会话**：Rust `delete_session_jsonl(cwd, sessionId)` + 注册；前端 ipc 包装；ChatHeader 下拉菜单 onDelete `window.confirm` 二次确认 → teardown → 删 jsonl → reset → 刷新 Sidebar。
- [ ] **派生到新工作树（基于 CLI `--fork-session`）** — 备选项，不一定实现。曾尝试落地（Rust `SpawnOptions.fork_session_id` + 前端 `forkPendingId` + ChatHeader 「分叉会话 / 复制为新会话」菜单），用户反馈命名晦涩、实际场景少，整段移除。
  若未来重做，命名规范为「**派生到新工作树**」，对齐 git worktree 心智：
  - 文案：菜单「派生到新工作树」+ tooltip「以当前会话历史为起点开一支独立分支，不影响本工作树」
  - 触发入口从 ChatHeader 菜单移到 Sidebar 右键，避开主流程误触
  - 跑前预览：sidecar 复制最近一次 result + 自动生成派生工作树名（`<原 cwd basename>-fork-<n>`）
- ~~复制深度链接（claudinal://）~~ — 取消：jsonl 本地存储，跨设备打不开；同设备多窗口/自跳转价值低，删除条目，菜单不留占位。

### 9.1.2a 流式中途引导输入（"插话"）

> CLI 支持在 Claude 思考 / 执行工具的过程中，先把后续的提示打进去 → 模型完成当前步骤后会把这条作为下一轮的输入读取。

- [x] **流式中途发送下一轮输入**：
  - Composer streaming 态：Enter 仍触发 send；按钮文案改「排队」（ListPlus 图标，secondary 变体）+ 旁边 ghost 图标按钮「中断」（Square）。
  - 排队中的 user 消息：reducer `user_local` action 加 `queued?: boolean`，立即 push 带 70% 透明度 + 右下角「将在当前回合后发送」chip（`Clock` 图标）。
  - 投递时机：`result` 事件触发 `setStreaming(false)`；`useEffect([streaming, pending, sessionId])` 监听到 !streaming && pending.length>0 → dequeue 一条 → 派发 `unqueue_local`（移到 entries 末尾 + 清 queued + 更新 ts，避免 buildGroups grouping 错位）→ `sendUserMessage` 投递。
  - 中断（Esc / Stop）：teardown 内 `setPending([])` + 对每条派发 `drop_local` 移除占位气泡 + toast 提示「已取消排队中的 N 条消息」。
  - `MessageStream::buildGroups` 看到 queued user 消息时不关闭当前 run（避免提前关掉运行中的 RunGroup）。

### 9.1.2b Sidebar 会话状态图标

- [x] **运行中会话显示 spinner**：
  - App.tsx 派生 `streamingJsonlId = streaming ? (selectedSessionId ?? findInitSessionId(state)) : null`，连同 `streamingProjectId` 透传给 Sidebar。
  - SessionRow 接 `streaming` prop；右侧固定区改成 `<div className="relative size-5">`，运行中显示 `<Loader2 className="size-3 animate-spin" />`（绝对定位，hover 时 fade out 让位给复制按钮）。
  - 置顶区与项目区下的 SessionRow 都生效。
  - 顺带修复：ChatHeader Pin/Copy/Delete 用 `jsonlSessionId`（resume id 或 system_init.session_id），不再误用本地 manager uuid。

### 9.1.2 主区 / 流式渲染

- [x] Markdown 渲染（react-markdown + remark-gfm + rehype-highlight，跟随主题色）
- [x] RunGroup 折叠/展开边框翻转（折叠下边框 / 展开上边框）
- [x] 用户消息「[Image: source: ...]」占位行剥离（保留真实 base64 图片）
- [x] RunGroup 流式占位 + 实时秒表（user 发送后立即 push run，startTs 兜底）
- [x] **每条对话消息可复制**：`CopyButton` 复用组件；user 气泡左侧 -7 偏移 hover fade in，assistant 文本块右上角 hover fade in；复制纯文本，不包含 RunGroup / thinking / tool_use 内容。
- [x] **会话图片点击放大**（lightbox，单图版）：`ImageLightbox` 全屏 dialog（Esc / 点击外部关闭），`object-contain max-w-[90vw] max-h-[90vh]`；ImageBlock 改成 button 触发，`cursor-zoom-in`，aria-label 含 imageAlt。多图左右切换留 P4。
- [x] **图片占位文本与真实图片关联**：reducer `bindImagePlaceholders` 按出现顺序把 `[Image #N]` / `[Image: source: <path>]` 与同条消息的 image block 配对，写入 `UIBlock.imageAlt`；`[Image #N]` 文中保留可读，`[Image: source: ...]` 剥离；缩略图右下角 #N 角标 + alt/title 提示。流式与历史 jsonl 都生效。
- [x] **文件 diff 全景视图**：`DiffOverview` 自定义侧拉抽屉（无 Sheet primitive，用 fixed inset 右贴 + 暗背景点击外部关闭）；按 filePath 聚合 user `tool_result.toolUseResult` 的 create/update；左列文件列表（+/- 计数 + FilePlus/FileEdit 图标）+ 右列 hunk diff（按 +/- 着色）；ChatHeader `GitCompareArrows` 按钮带文件数 badge，0 文件时禁用。
- [x] **权限拒绝渲染**：`ResultView` 在 result chip 下方保留 `PermissionDenialList`（红 chip + ShieldAlert 图标），作为 hook/MCP 权限桥不可用时的显式兜底；不再提供静默写全局 allowlist 的按钮。
- [x] **hook_event 侧边 chip**：reducer `reduceHook` 处理 `hook_event` / `hook` 事件 → `UIHookEvent`；`HookEventView` 渲染为可展开 chip（`Webhook` 图标 + hookEventName + toolName + 完整 raw JSON）。
- [x] **Bash 终端样式美化**：Bash/PowerShell ToolUseDetails 改 `TerminalBlock`（带 macOS 风三圆点 header + 暖橙 `$` / `PS>` 提示符 + 等宽多行）；ToolResultBlock 兜底分支统一改 `CollapsedOutput`（>8 行折叠预览 + 「展开全部 / 收起」按钮）。ANSI 着色留 P4。

### 9.1.3 设置页

- [x] P3.1 常规：自动检查更新 toggle（启动 / 关闭行为留 P4）
- [x] P3.3 配置：默认 model / effort / permission_mode / CLAUDE_CLI_PATH（写 `claudinal.settings`，spawn 时 `loadSettings()` 注入）
- [ ] P3.4 个性化：CLAUDE.md 三 scope 编辑（global / project / project-local）+ pin 高频 slash；**不做** Codex 风记忆系统
- [ ] P3.5 MCP 服务器：列表卡 + 启用 toggle；详情编辑分 STDIO / 流式 HTTP，字段含启动命令 / 参数 / 环境变量 / 环境变量传递 / 工作目录；scope = global(`~/.claude/mcp.json`) / project(`<cwd>/.mcp.json`)；**需新增 Breadcrumb 组件**
- [ ] P3.7 环境（项目级）：项目列表 + 编辑视图（名称 / 设置脚本 / 清理脚本 / 操作，按 default/macOS/Linux/Windows 平台分 tab）；存 `localStorage["claudinal.project-env"]`；**复用 Breadcrumb 组件**
- [ ] P3.6 / 3.8 / 3.9 / 3.10：Git / 工作树 / 浏览器 / 已归档对话（占位）
- [x] P3.11 账号 & Usage：apiKeySource 来自 system_init（写 `claudinal.api-key-source`）+ `recordResultUsage` 在 result 事件累计 modelUsage 到 `claudinal.usage`；Account 页面显示登录方式 + 总成本 / tokens / cache + 按模型拆分表 + 清空 usage 按钮
- [ ] P3.12 收尾：测试连接按钮（spawn `curl --proxy ... -I https://api.anthropic.com`）+ keychain 加密密码 + PAC URL + 全应用范围（含 webview，等 Tauri 2 setProxy 稳定）

### 9.1.4 代码 / 渲染细节遗留

- [x] **Result chip 持久化**：Rust `read/write_session_sidecar(cwd, sid)` 命令；前端 result 事件到来时写 `~/.claude/projects/<encoded>/<sid>.claudinal.json`（`{ result: <event> }`）；switchSession 加载 transcript 后合并 sidecar.result 到 events 末尾，让 ResultView chip 在历史会话也显示。
- [x] 历史 jsonl 用 timestamp 字段还原 step.startedAt/endedAt（reducer.parseTs）
- [x] **RunGroup 时长口径与 CLI 对齐**：RunGroup 已优先用 `result.duration_ms`（CLI 全程墙钟）；reducer 在 `message_stop` 时记录 `UIMessage.stopTs`；buildGroups assistant 分支用 `m.stopTs ?? m.ts` 推 endTs，避免末尾 text 段漏算。startTs 仍取首个 user 消息 ts。
- [x] **AssistantMarkdown 流式节流**：自定义 `useThrottledText` 在 partial 期间限制 80ms 同步一次；`useDeferredValue` 让 React 把 markdown 重 parse 推迟到空闲帧；`MarkdownInner` 用 `memo` 包裹避免相同 text re-render。完成态（partial=false）立即升级到完整文本。
- [x] **notify watcher 增量更新**：Rust `WatcherState`（基于 `notify` crate，200ms 节流，仅触发 .jsonl 修改）→ emit `claudinal://sessions/<cwd>/changed`；前端 Sidebar `useEffect` 挂载时 `watchSessions` + `listenSessionsChanged` 触发 `loadSessions(p)` 增量刷新；卸载时 `unwatchSessions`。
- [ ] sqlite 索引（当前 jsonl 全量扫描，超过几百 session 后再升）
- [x] **@ 文件补全 / 斜杠面板**：Rust `list_files(cwd, prefix)` 浅扫（max depth 4 / 500 项，跳过 node_modules/.git/target 等）；前端 `SuggestionPanel` 浮在 Composer 上方；@ 触发文件补全（按相对路径模糊匹配，文件优先短路径优先），/ 触发斜杠命令（`system/init.slash_commands` + `FALLBACK_SLASH` 兜底）；↑↓ 选择 / Tab/Enter 补全 / Esc 关闭。

---

## 10. 当前进度快照（2026-04-30）

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
- ✅ **2026-04-30 大改**（Codex 风落地）：
  - thinking / tool_use 块加 `startedAt/endedAt`；reducer 在 user `tool_result` 出现时反向给 assistant 中对应 tool_use 写 `endedAt`
  - 新增 `RunGroup` 合并卡片：同一轮 thinking + tool 在流式中默认展开，完成后坍缩为「已处理 3m55s · N 步」，**展开方向向上**（trigger 在底，内容在上），折叠下边框 / 展开上边框
  - 流式占位：发送 user 消息后立即 push 空 run（带 startTs），实时秒表跑，避免空白等待焦虑
  - Markdown 渲染：`react-markdown + remark-gfm + rehype-highlight`，自定义 components 跟随 Claudinal 主题色（hljs token 写到 index.css）
  - 用户消息中 `[Image: source: ...]` 占位行被剥离
  - 主区 `ChatHeader`：标题 + cwd 名 + DropdownMenu（置顶 / 重命名 / 打开目录 / 复制 ID / 复制 resume / 删除）+ 右侧预留 diff 图标位
  - Sidebar 重设计：去左侧 chat 图标；hover 显示左侧 Pin；置顶顶部独立区，置顶不参与项目筛选；只剩置顶会话的项目从下方列表隐藏；项目行删除图标改 destructive 红 + 新增打开目录按钮
  - Settings 内容区改 ScrollArea；Network 去 sticky 顶/底 + 上边框；shadcn `Switch` / `Select` primitives；密码用浏览器原生
  - Composer 去 `border-t`；Header 去 `border-b`；三块视觉不再被分割线切开
  - `dropdown-menu` primitive（基于 `@radix-ui/react-dropdown-menu`）
  - Rust 新增 `open_path` 命令（Windows explorer / macOS open / Linux xdg-open）
  - `lib/pinned.ts`：localStorage `claudinal.pinned` 置顶 store
  - 项目列表稳定排序（去掉 `touchProject` 引发的上浮）
  - Sidebar 会话副信息行 msg 数 / 时间 space-between 排版
  - 切换会话 MessageStream 用 sessionId 作 key，强制重挂载避免内部 state 残留
- ✅ **2026-04-30 后续（会话项交互 & 排队）**：
  - Sidebar 运行中 spinner（`streamingProjectId/streamingSessionId` 透传 + 绝对定位 fade）
  - Rust 新增 `delete_session_jsonl` 命令；ChatHeader 下拉菜单删除会话（`window.confirm` 二次确认）
  - 自定义会话标题 store（`src/lib/sessionTitles.ts`）+ `RenameSessionDialog`；Sidebar/ChatHeader 都优先读自定义
  - ChatHeader 切换为 `jsonlSessionId` 取代本地 manager uuid（修复新会话 pin/copy 用错 id 的 bug）
  - 流式中途排队消息（"插话"）：reducer 加 `user_local.queued / unqueue_local / drop_local`；Composer streaming 时 Enter 改排队，旁边 ghost「中断」按钮；teardown 清空队列；buildGroups 排队消息不关闭当前 run
- ✅ **2026-04-30 后续 #2（消息 / 图片 / 时长口径）**：
  - `CopyButton` 复用组件；user 气泡 hover 才显示，assistant 文本块复制按钮常显（codex 风），位置贴正文左下/右下，不浮出
  - `ImageLightbox` 全屏 dialog；ImageBlock 改 button 触发；`cursor-zoom-in`；Esc / 点击外部关闭
  - reducer `bindImagePlaceholders` 优先用 `[Image #N]` 数字（与文中字样所见即所得）；source 形态仅剥离不计入配对；缩略图右下角 #N 角标
  - `UIMessage.stopTs` 在 `message_stop` 时记录；buildGroups 用 `stopTs ?? ts` 推 endTs，对齐 CLI Crunched 时长（result.duration_ms 仍优先）
- ✅ **2026-04-30 后续 #3（持久化 & diff 全景）**：
  - Result chip sidecar：Rust `read/write_session_sidecar`；前端 result 事件落 `<sid>.claudinal.json`，switchSession 时合并；删 jsonl 同步删 sidecar
  - 文件 diff 全景：`DiffOverview` 侧拉抽屉（fixed 右贴）；按 filePath 聚合 create/update；左列 +/- 计数 + 图标，右列 hunk 着色；ChatHeader `GitCompareArrows` 带 diffCount badge
- ✅ **2026-04-30 后续 #4（buddy / Bash / Fork / 流式节流）**：
  - 切换会话过渡：`BuddyLoader` 复刻 buddy.md 电子宠物（3 物种 cat/duck/owl × 3 眼睛 × 5 稀有度加权 × 1% 闪光）；15 帧 IDLE_SEQUENCE / 500ms；自动每 5s 触发 5 帧 ♥ 抚摸特效，无需点击
  - Bash 终端样式：`TerminalBlock`（macOS 三圆点 + 暖橙提示符）；`CollapsedOutput`（>8 行折叠 + 展开按钮）替代所有 ToolResultBlock 兜底
  - Fork session：Rust `--fork-session` 透传；`forkPendingId` 在 ensureSession 注入；ChatHeader「分叉会话」菜单
  - AssistantMarkdown 节流：`useThrottledText`（80ms）+ `useDeferredValue` + `memo` 三件套
- ✅ **2026-04-30 后续 #5（权限 / hook / 设置 / watcher / 补全）**：
  - 权限拒绝渲染（headless 协议无双向交互，渲染 `result.permission_denials`）
  - hook_event reducer 分支 + chip 渲染（Webhook 图标 + raw JSON）
  - P3 设置：General（自动更新 toggle）/ Config（model/effort/permission/CLI 路径）/ Account（登录方式 + usage 累计 + 按模型拆分表）；`claudinal.settings` + `claudinal.usage` + `claudinal.api-key-source` 三个 store；spawn 时 `loadSettings` 注入参数
  - notify fs watcher：Rust `WatcherState` + 200ms 节流 + Sidebar 增量刷新
  - @ 文件补全 + / 斜杠面板：Rust `list_files`（4 层深度 / 500 上限 / 跳过常见构建目录）+ `SuggestionPanel` 浮窗 + ↑↓ Tab/Enter Esc 键盘交互
- ✅ **2026-04-30 后续 #6（settings.json 集成 / 权限 Phase 2 / bug 修复）**：
  - 修补全点击 bug：SuggestionPanel 加 `onMouseDown preventDefault` 阻止 textarea blur 抢先关面板吞掉 onClick
  - 斜杠命令本地路由：`/clear` / `/reset` 客户端清空会话；其他斜杠仍发给 CLI 但 toast 提示是 TUI 专属
  - Rust `read/write_claude_settings(scope, cwd?)` + `claude_settings_path_for(scope)`，scope=global/project/project-local
  - Config 分类重写：直接读写 `~/.claude/settings.json`（model / effortLevel / language / alwaysThinkingEnabled / env）；env 区列出 Anthropic 系列 + 代理 env，敏感字段（AUTH_TOKEN / API_KEY）显隐切换；右上角「打开 settings.json」按钮
  - Account 分类重写：`detectAuth(env, apiKeySource)` 区分第三方 API（AUTH_TOKEN）/ 官方 key / OAuth / 未登录；显示 base URL + 脱敏 token；本机累计 usage 改副标题；新增「计划用量限额」占位（数据接口待 P4）
  - plan.md §13 新增「权限审批模块（独立设计）」：现状 + stdio control/MCP 路径 + 不默认写 settings 的阶段性方案 + 不做清单
  - 权限 Phase 2 原方案废弃：不再从 denial 卡片静默写 `~/.claude/settings.json`，改由 `control_request` 在请求发生时让用户选择
  - App.tsx 恢复 `loadSettings` 注入，用于 app 侧默认 model/effort/permission-mode/MCP 权限工具参数
- ✅ **2026-04-30 后续 #7（OAuth 用量真接口 / Config 收敛 / 代理冲突）**：
  - 调研官方 settings.json schema（https://code.claude.com/docs/en/settings）：确认 effortLevel 字段名（取值 low/medium/high/xhigh，无 max）；permissions 含 allow/ask/deny/defaultMode/additionalDirectories；OAuth 凭据存 `~/.claude/.credentials.json` 的 `claudeAiOauth.accessToken`（macOS 在 Keychain，留 P4）
  - Config 分类收敛：移除 env 编辑（避免和 OAuth/第三方 API 冲突），只保留 model / effortLevel / language / alwaysThinkingEnabled；底部提示「env / 鉴权 / 权限请直接编辑 settings.json」
  - Rust `read_claude_oauth_token` + `fetch_oauth_usage` 命令（`reqwest 0.12 + rustls-tls`）；调 `GET https://api.anthropic.com/api/oauth/usage`（Bearer + `anthropic-beta: <DEFAULT_OAUTH_BETA or env override>`）
  - Account 计划用量：按 Anthropic.com 截图 1:1 复刻「计划用量限额 / 每周限额」中文文案（当前会话 / 全部模型 / 仅 Sonnet / 仅 Opus），UsageBar grid 三栏 + 暖橙/警黄/destructive 阈值；删 Extra usage 段；不在响应里的字段（Claude Design / Daily routine runs）干脆不显示
  - 网络代理冲突检测：Network 页加载时读 settings.json env.HTTPS_PROXY/HTTP_PROXY；若有则顶部黄色警告卡（CLI 启动时 settings.json env 优先级高于 spawn 注入），引导去 Config 打开 settings.json 删除冲突字段
- ✅ **2026-04-30 后续 #8（Usage / Statistics 拆分 + fork 废弃 + 二次确认）**：
  - 设置页拆分：Account 改名「Usage」（仅登录 + 计划用量）；新增「统计」分类
  - Rust `chrono` 依赖；`scan_all_usage_sidecars` 全局扫 sidecar 累加；`scan_activity_heatmap(days)` 扫所有 jsonl 按本地时区桶到 (date, hour, count)
  - Statistics 页：全部会话累计（成本 / tokens / cache / 按模型）+ 30 天 × 24 小时 ActivityHeatmap（Tooltip 显示日期+小时+消息数，5 档暖橙强度）
  - Fork 功能整段废弃（Rust SpawnOptions.fork_session_id / --fork-session、ChatHeader 菜单项、App forkCurrentSession + forkPendingId、ipc.forkSessionId 全部移除）
  - 通用 `ConfirmDialog` 走 shadcn `AlertDialog`（`@radix-ui/react-alert-dialog`，role=alertdialog，按 Esc / 点外部不关，专门给不可逆操作）；删除会话 + 项目从列表移除全部走 Dialog 二次确认替代 window.confirm
  - 「分叉会话」菜单项已移除（用户反馈命名晦涩 + 实际场景少）；plan.md §9.1.1 标记为备选项，未来重做时命名规范定为「派生到新工作树」（对齐 git worktree 心智）
- ✅ **2026-04-30 后续 #9（Welcome 默认项目 + 项目选择器 + 计划口径修正）**：
  - 启动时若已有项目，App.tsx 自动选中列表第一个，进入「要在 X 中构建什么？」环境，不再被 Welcome「添加项目」拦截
  - 新增 `ProjectPicker`（DropdownMenu + 搜索 + 项目列表勾选 + 「添加新项目」 + 「不使用项目」），挂在 Welcome 居中 Composer 下方左对齐
  - 外观默认值改成 Claude 预设实值（`appearance.ts` `CLAUDE_DEFAULT` 常量 + `defaultAppearance()` 导出）；旧版 `{}` 视为升级到 Claude；matchPreset 移除 allEmpty=Claude 兜底；resetAll / 单模式 reset 都回到 Claude 预设；修复 `update(mode, {})` 实际不清空字段的 bug
  - Button base class 加 `cursor-pointer`（disabled 由 `pointer-events-none` 自然回退）
  - plan.md §6 P3.4 / P3.5 / P3.7 重写：个性化对齐 Claude Code（CLAUDE.md 三 scope 而非 Codex 风记忆）；MCP 详情字段（启动命令 / 参数 / 环境变量 / 环境变量传递 / 工作目录，STDIO + 流式 HTTP 切换，scope global/project）；环境分类改为项目级运行环境（设置脚本 / 清理脚本 / 平台 tab / 操作）
  - plan.md §11.19 新增 Breadcrumb 组件约定（自实现轻量版，供 P3.5 / P3.7 共用）
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
| 权限请求 GUI 接管       | `--permission-prompt-tool stdio` + Tauri 权限弹窗 | 补充真实 control/MCP 样本并记录 schema |
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

### 11.19 Breadcrumb 组件（P3.5 MCP / P3.7 环境共用）

> 设置页内的多级页面导航（`MCP 服务器 > playwright > 编辑`、`环境 > {项目名} > 编辑`）需要一个轻量 Breadcrumb，**不引入 shadcn breadcrumb registry**，自己写一个 50 行内组件即可。

- 文件：`src/components/ui/breadcrumb.tsx`
- API（含义对齐 Radix / shadcn 习惯）：
  ```tsx
  <Breadcrumb>
    <BreadcrumbItem onClick={onBack}>← 返回</BreadcrumbItem>
    <BreadcrumbSeparator />
    <BreadcrumbItem onClick={() => setView("list")}>MCP 服务器</BreadcrumbItem>
    <BreadcrumbSeparator />
    <BreadcrumbItem current>playwright</BreadcrumbItem>
  </Breadcrumb>
  ```
- 视觉：横向 flex + `text-xs text-muted-foreground`；非 `current` 项 `cursor-pointer hover:text-foreground`；`current` 不响应点击；分隔符用 `ChevronRight` lucide 图标 size-3 opacity-60。
- 不做 dropdown / ellipsis 折叠（路径深度不超过 3 级，没必要）。
- 设置页分类视图改造：每个分类组件在内部维护 `view: "list" | "edit" | "detail"` 与 `selected`（编辑/详情对应的项 id）；Settings.index.tsx 不感知子视图；Breadcrumb 永远渲染在分类页顶部。

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

---

## 12. 构建体积 & 打包产物

### 12.1 Vite chunk 拆分（已实施）

`vite.config.ts` 加 `build.rollupOptions.output.manualChunks`，按 node_modules 路径分桶：

| chunk 名 | 命中规则 |
| --- | --- |
| `markdown` | `react-markdown` / `remark-*` / `rehype-*` / `micromark` / `mdast` / `hast` / `unified` / `unist-*` |
| `highlight` | `highlight.js` / `lowlight` |
| `radix` | `@radix-ui/*` |
| `icons` | `lucide-react` |
| `react` | `react` / `react-dom` / `scheduler` |
| `vendor` | 其余 node_modules |

同时 `build.target = "es2022"`、`chunkSizeWarningLimit = 800`，避免误报。

后续优化备选（按需）：
- `react-markdown` / `rehype-highlight` 改成动态 import（仅 MessageStream 用到，进一步减小首屏 JS）
- 设置页 12 个 sections 改成 `React.lazy` + `<Suspense>`，仅在打开 Settings 时加载

### 12.2 Rust release profile（已实施）

`src-tauri/Cargo.toml [profile.release]`：`lto = true` / `opt-level = "s"` / `codegen-units = 1` / `panic = "abort"` / `strip = true`，确保单文件 exe 最小。

### 12.3 npm 打包脚本（已新增，跨 Windows / macOS / Linux）

> Tauri 打包受限于运行平台：**Windows 产物只能在 Windows 打**，**macOS 产物只能在 macOS 打**，**Linux 产物只能在 Linux 打**（除非交叉编译或走 GitHub Actions 矩阵）。脚本按平台分组提供。

#### 通用

| 命令 | 说明 |
| --- | --- |
| `pnpm tauri:dev` | 开发模式 |
| `pnpm tauri:build` / `pnpm package` | 打当前平台 `tauri.conf.json::bundle.targets` 列出的全部目标 |

#### Windows（在 Windows 上跑）

| 命令 | 产物路径 |
| --- | --- |
| `pnpm package:exe` | `src-tauri/target/release/bundle/nsis/Claudinal_<ver>_x64-setup.exe`（NSIS 安装器，**双击即装，currentUser 不要管理员**） |
| `pnpm package:msi` | `src-tauri/target/release/bundle/msi/Claudinal_<ver>_x64_en-US.msi` |
| `pnpm package:win` | NSIS + MSI 双产物 |

单文件主程序（无安装器）：`src-tauri/target/release/claudecli-desktop.exe`，可直接拷贝运行（Tauri 无内置 portable bundler，单文件即视为绿色版）。

#### macOS（在 macOS 上跑）

| 命令 | 产物 |
| --- | --- |
| `pnpm package:mac-app` | `src-tauri/target/release/bundle/macos/Claudinal.app`（.app 包） |
| `pnpm package:dmg` | `src-tauri/target/release/bundle/dmg/Claudinal_<ver>_<arch>.dmg`（拖拽安装镜像） |
| `pnpm package:mac` | .app + dmg 双产物 |
| `pnpm package:mac-universal` | 通用二进制（Intel + Apple Silicon），需先 `rustup target add x86_64-apple-darwin aarch64-apple-darwin` |

注意：默认未配置代码签名 / 公证，分发时 macOS 会触发 Gatekeeper 提示「应用已损坏」，需用户右键打开或在「系统设置 > 隐私与安全性」放行。生产分发需配置 Apple 开发者证书（留 P4）。

#### Linux（在 Linux 上跑）

| 命令 | 产物 |
| --- | --- |
| `pnpm package:deb` | `src-tauri/target/release/bundle/deb/claudinal_<ver>_amd64.deb`（Debian / Ubuntu） |
| `pnpm package:rpm` | `src-tauri/target/release/bundle/rpm/claudinal-<ver>-1.x86_64.rpm`（Fedora / RHEL，需要安装 `rpm` 工具链） |
| `pnpm package:appimage` | `src-tauri/target/release/bundle/appimage/claudinal_<ver>_amd64.AppImage`（绿色版，跨发行版） |
| `pnpm package:linux` | deb + rpm + appimage 三产物 |

Linux 系统依赖（首次需安装）：
```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev
```

#### CI 多平台矩阵建议

```yaml
strategy:
  matrix:
    include:
      - os: windows-latest
        cmd: pnpm package:win
      - os: macos-latest
        cmd: pnpm package:mac
      - os: ubuntu-22.04
        cmd: pnpm package:linux
```

#### 通用注意

- `tauri.conf.json::bundle.targets` 设为 `["nsis", "app", "dmg", "deb", "appimage"]`，Tauri 会自动跳过当前平台不支持的目标，无需按 OS 切换配置文件
- 首次构建 Cargo 会下载 + 全量编译依赖，5-15 分钟；后续增量秒级
- 图标统一在 `src-tauri/icons/icon.png`，Tauri 会按需生成 .icns / .ico；如需更精细图标可补 `icon.icns` / `icon.ico` 同名文件

### 12.4 实际产物与一键打包脚本（已实施）

> 实测产物（macOS 类似 .app/.dmg，Linux 类似 deb/rpm/AppImage，本节给 Windows 实测路径）：
>
> - `src-tauri/target/release/claudecli-desktop.exe` — 单文件主程序（约 5.7 MB）
> - `src-tauri/target/release/bundle/nsis/Claudinal_<ver>_x64-setup.exe` — NSIS 安装器（约 2.2 MB）

`scripts/package-release.mjs` 把上面两个产物分别打成 zip，输出到 `dist/` 同级的 `release/`：

| 命令 | 产物 |
| --- | --- |
| `pnpm package:zip-portable` | `release/Claudinal-<ver>-portable.zip`（含 `Claudinal.exe` + `README.txt`） |
| `pnpm package:zip-installer` | `release/Claudinal-<ver>-setup.zip`（含 `Claudinal_<ver>_x64-setup.exe`） |
| `pnpm package:zip` | 同时输出两个 zip（缺哪个 skip 哪个，配合 `pnpm package:exe` 使用） |
| `pnpm release:exe` | 一条龙：`tauri build --bundles nsis` + `package:zip` |

`release/` 已加入 `.gitignore`。zip 命令在 Windows 用 PowerShell `Compress-Archive`，在 macOS / Linux 用 `zip -r -9` 命令。

### 12.5 NSIS 离线引导（中国大陆网络环境）

`tauri build --bundles nsis` 首次构建会从 GitHub releases 下载两个文件：
- `nsis-3.11.zip`（NSIS 工具链本体，约 2.3 MB）
- `nsis_tauri_utils.dll`（Tauri 自定义 NSIS 插件，约 30 KB，版本随 tauri-bundler 升级，**当前 tauri 2.10.x 用 v0.5.3**）

如果直连 GitHub 不通会卡在 `failed to bundle project: timeout: global`。提供 `pnpm bootstrap:nsis` 走 ghproxy 镜像（`MIRROR=https://ghproxy.net/` 默认）一次性把两个文件放到 `%LOCALAPPDATA%\tauri\NSIS\`，之后离线 `pnpm package:exe` 直接用缓存：

```bash
pnpm bootstrap:nsis
# 或自定义镜像：
MIRROR=https://mirror.ghproxy.com/ pnpm bootstrap:nsis
# 或直连：
MIRROR= pnpm bootstrap:nsis
```

注意：Tauri 升级后 `nsis_tauri_utils.dll` 版本可能跟着变，需要同步更新 `scripts/bootstrap-nsis.mjs::TAURI_UTILS_VERSION`；定位方法是先跑一次 `pnpm package:exe` 看 Tauri 的 Downloading 日志。

### 12.6 实测结果（2026-04-30）

- ✅ Windows 上 `pnpm package:exe` 全流程通过：tsc + vite build（前端 chunk 6 个：react 193k / index 191k / markdown 156k / radix 106k / icons 30k / css 56k）→ cargo release（1m 50s）→ NSIS 打包 → 安装器 2.2 MB
- ✅ `pnpm package:zip-portable` 输出 `Claudinal-0.1.0-portable.zip` (2.7 MB，含 5.7 MB exe + README)
- ✅ `pnpm package:zip-installer` 输出 `Claudinal-0.1.0-setup.zip` (2.2 MB，含 setup.exe)
- ✅ NSIS 离线引导：从 ghproxy.net 下载 nsis-3.11.zip + nsis_tauri_utils.dll v0.5.3 成功

---

## 13. 权限审批模块（独立设计）

> **TL;DR**：首选不是事后写 `settings.json.permissions.allow`，也不是自建工具执行层，而是用 Claude Code 原生 stdio 权限控制协议接管 GUI 授权。启动 `claude -p` 时默认传 `--permission-prompt-tool stdio`，CLI 发出 `control_request` 后由桌面端弹窗，用户选择后写回 `control_response`。这样不修改本机配置，且保留 CLI 自己的权限判断和执行路径。

### 13.1 当前观察（来自 `doc/stream-json-permission.txt`）

- 用户提示：`跑一下 curl https://example.com -I`
- 在未接管权限请求时，CLI assistant 文字：`命令需要你批准后才能执行。请在权限提示中允许，或运行 /permissions 添加 Bash(curl:*) 到允许列表后我再重试。`
- `result` 事件里出现：
  ```json
  "permission_denials": [
    {
      "tool_name": "Bash",
      "tool_use_id": "toolu_…",
      "tool_input": { "command": "curl https://example.com -I", "description": "…" }
    }
  ]
  ```
- 这说明当前 headless `stream-json` 流没有被 GUI 接管权限请求，CLI 最终只能把拒绝结果写进 `result.permission_denials`。
- 实测结论：`PermissionRequest` hook 在当前 `claude -p --input-format stream-json` 路径下没有触发。加入 `--permission-prompt-tool stdio` 后，CLI 会在 stdout 发出 `type:"control_request"`，并等待 stdin 上同 `request_id` 的 `control_response`。

### 13.2 首选方案：stdio 权限控制协议

启动会话时，`Manager::spawn` 默认追加：

```text
--permission-prompt-tool stdio
```

当 stdout 出现 `control_request`：

```json
{
  "type": "control_request",
  "request_id": "…",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "Write",
    "display_name": "Write",
    "input": { "file_path": "…", "content": "…" },
    "permission_suggestions": [
      { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
    ]
  }
}
```

Rust 后端处理链路：

1. stdout reader 识别 `control_request`。
2. 注入 GUI 内部 `session_id` 和 `cwd`，通过 Tauri event 发给前端。
3. 前端弹窗展示工具名、说明、参数、CLI 给出的 `permission_suggestions`。
4. 用户选择后通过 Tauri command 回写同一个 Claude CLI 进程 stdin。
5. 回写格式：

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "…",
    "response": { "behavior": "allow", "updatedInput": { } }
  }
}
```

用户选择映射：

| GUI 选项 | control response 内层 `response` |
| --- | --- |
| 是 | `behavior:"allow"` + `updatedInput:<原 tool input>` |
| 否 | `behavior:"deny"`，`message` 告诉 Claude 用户拒绝及原因 |
| 本次会话允许所有编辑 | `behavior:"allow"` + `updatedPermissions:[{type:"setMode", mode:"acceptEdits", destination:"session"}]` |
| 本次会话允许此类工具 | `behavior:"allow"` + `updatedPermissions:[{type:"addRules", rules:[...], behavior:"allow", destination:"session"}]` |
| 写入项目本地规则 | `behavior:"allow"` + `updatedPermissions:[{type:"addRules", rules:[...], behavior:"allow", destination:"localSettings"}]`，仅用户明确选择时写 `.claude/settings.local.json` |

### 13.3 MCP 增强定位

Rust 侧内置一个最小 MCP permission server：同一个 Tauri 二进制正常运行时启动 GUI；带 `--permission-mcp-server` 参数运行时进入 stdio MCP server 模式。

- 设置中用“使用 MCP 权限工具”开关控制。关闭时走内置 `stdio` control 弹窗；开启时传 `--permission-prompt-tool` 和 `--mcp-config`。
- 默认工具名：`mcp__claudinal_permission__approval_prompt`。
- 默认 MCP 配置 JSON 指向 `${CLAUDINAL_EXE} --permission-mcp-server`，后端启动时把 `${CLAUDINAL_EXE}` 替换为当前应用二进制路径。
- MCP server 无 GUI bridge 环境时默认拒绝权限请求；由桌面端 spawn 时会注入本地 bridge env，把 MCP tool call 转发到同一个权限弹窗。
- 已验证：直接 JSON-RPC 调用 `initialize` / `tools/list` / `tools/call` 正常；Claude CLI 通过 `--mcp-config` 加载后 `claudinal_permission` 为 connected，`--permission-prompt-tool mcp__claudinal_permission__approval_prompt` 能拦截 Write 权限并拒绝，测试文件未创建。

### 13.4 兜底与兼容

- 保留现有 `result.permission_denials` 渲染，作为 hook 未启用、hook 失败、CLI 版本不支持时的显式错误展示。
- 不再默认写 `~/.claude/settings.json` 或项目 `.claude/settings.local.json`。
- 只有用户在 GUI 明确选择“写入项目本地规则”或类似持久化选项，才返回 `updatedPermissions.destination = "localSettings"`。
- 会话级授权一律使用 `destination:"session"`，不落盘。

### 13.5 不做清单

- 自行 patch CLI 二进制注入 hook —— 升级即失效，且违反 plan §1 不变量。
- 默认开启 `acceptEdits` 或 `bypassPermissions` 来绕过权限问题 —— 会扩大误删、误改风险。
- 静默写 `settings.json.permissions.allow` —— 用户没有明确授权持久化时不落盘。
- 在桌面端自己执行 Bash/Edit/Write —— 会变成自研 agent/tool runtime，违反“不重造 agent”原则。
