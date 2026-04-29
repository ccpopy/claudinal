# Claudinal — 视觉与交互风格规范

> 本文是 Claudinal 桌面端 UI 的一致性约定。新增 / 改动任意页面、组件、样式前必读。
> 与 `plan.md` 配套：plan 管「做什么」，style 管「怎么做才看着是同一个产品」。
>
> **强约束**：违反这里的条目应当被视为 bug，而不是风格偏好。
> 如果某条规范让任务做不下去，先来这里改文档，再去改实现 —— 不要让多份代码各走各的。

---

## 1. 总体气质

- **参考标杆**：OpenAI Codex 桌面端 + Claudia + shadcn/ui new-york style。
- **关键词**：克制、低噪、留白、卡片化、流式优先、可逆操作。
- **反例**：花哨渐变、彩色阴影、跳动表情、AI 助理拟人化插图。
- **品牌名**：始终写作 **Claudinal**（不是 ClaudeCLI / Claude Desktop / claudecli）。
  - localStorage key 历史遗留前缀 `claudecli.*` 保留以兼容老用户数据；新增 key 一律 `claudinal.*`。
  - Rust crate 名 `claudecli-desktop` 暂留，不影响产品名展示。

---

## 2. 优先用 shadcn/ui，不要自己造轮子

> **铁律**：如果有 shadcn primitive，必须用它；不要为了"少装一个依赖"自己写。

| 控件         | 必须用                                                          | 不允许                                                |
| ------------ | --------------------------------------------------------------- | ----------------------------------------------------- |
| 按钮         | `Button` (`@/components/ui/button`)                             | 裸 `<button>` 加自定义样式                            |
| 输入框       | `Input`                                                         | 裸 `<input>` 加 border 拼                             |
| 多行输入     | `Textarea`                                                      | 裸 `<textarea>`                                       |
| 下拉单选     | `Select` (`@/components/ui/select`)                             | 裸 `<select>` + chevron 散写                          |
| 开关         | `Switch`                                                        | 自己拼 button + role="switch"（前期遗留代码已统一）   |
| 标签         | `Label`                                                         | `<label>` / `<span>` 装作 label                       |
| 滚动         | `ScrollArea`                                                    | `overflow-y-auto` 直接糊（除非组件内已嵌 ScrollArea） |
| 弹窗         | `Dialog` / `DialogContent`                                      | 自己写遮罩 + 居中容器                                 |
| 下拉菜单     | `DropdownMenu*`                                                 | 自己写 popover                                        |
| 提示         | `Tooltip`                                                       | `title` 属性 + 自定义 hover 浮层                      |
| Toast        | `sonner` (`<Toaster />` + `toast.xxx`)                          | 自己写 banner                                         |
| 分隔线       | `Separator`                                                     | `<hr>` / `<div className="h-px bg-border">`           |
| 折叠         | `Collapsible` 或现有 `RunGroup` / `MessageBlocks::ExpandableRow` | 重新自己写 grid-rows 0fr→1fr                          |
| 徽章         | `Badge`                                                         | 自定义 span 拼                                        |
| 卡片         | `Card`（数据类容器）/ 自己用 `rounded-lg border bg-card`（普通分块） | 二者混用                                              |

新增 primitive 流程：
1. 优先用 `pnpm dlx shadcn@latest add <name>`；
2. 不可用则手写到 `src/components/ui/<name>.tsx`，遵循 new-york 风（`data-slot`、`cn(...)`、React 19 不要 forwardRef）。
3. 在本表追加一行。

---

## 3. 色系与主题

### 3.1 色 token（`src/index.css`，`@theme inline` 暴露给 Tailwind）

| token                           | 角色                                |
| ------------------------------- | ----------------------------------- |
| `--background` / `--foreground` | 主区底色 / 文字                     |
| `--card` / `--card-foreground`  | 数据型卡片底色                      |
| `--muted` / `--muted-foreground`| 次级信息（hint、副标题、metadata）  |
| `--primary` / `--primary-foreground` | Claude 暖橙调（默认 `oklch(0.66 0.13 40)`），强调按钮 / 选中态 |
| `--accent` / `--accent-foreground` | hover 态、轻强调                  |
| `--secondary`                   | 次按钮 / 中性 chip                  |
| `--destructive`                 | 删除、错误、退出登录                |
| `--border` / `--input`          | 边框 / 输入框边                     |
| `--ring`                        | focus 环                            |
| `--sidebar*`                    | 左栏专用 5 件套                     |
| `--user`                        | user 气泡背景                       |
| `--thinking`                    | thinking 卡片背景                   |
| `--tool`                        | tool 卡片背景                       |
| `--connected`                   | 成功 / 在线点 / +diff               |
| `--warn`                        | 注意 / dirty / -1h 限额             |

> **不要在组件里写 hex 或 oklch**。永远走 token，否则深浅切换 + 用户自定义都会破。
> 引用方式：`bg-primary` / `text-muted-foreground` / `border-warn/40` 等，shorthand 已在 `@theme inline` 注册。

### 3.2 浅色 / 深色

- 默认 light（Claude 暖橙），dark 为中性灰底 + 暖橙强调。
- `:root, .light { ... }` 与 `.dark { ... }` 并存；FOUC 防抖脚本在 `index.html` 顶部。
- 主题切换走 `useTheme` (`@/lib/theme`) — 不要自己改 `documentElement.classList`。

### 3.3 用户可配置（外观设置）

- 浅色 / 深色 **独立配置**，互不污染。每套 6 项：accent / background / foreground / fontUI / fontMono / translucentSidebar / contrast。
- 实时生效：`applyAppearance(resolvedTheme, cfg)` 直接 `setProperty('--primary', value)`，不刷新页面。
- 预设主题集（Claude / Codex / Absolutely）= 一键覆盖一组 token。
- **新增可配置项必须经过 `Appearance.tsx` 的 ColorRow / FontRow / ToggleRow / RangeRow**，不要在某个角落另搞一套设置。

### 3.4 hljs 代码高亮

- 不引入第三方 hljs 主题 css，统一在 `index.css` 末尾用 token 写：
  - `.hljs-keyword` → `--primary`
  - `.hljs-string / .hljs-built_in` → `--connected`
  - `.hljs-number / .hljs-literal` → `--warn`
  - `.hljs-deletion` → `--destructive`
  - `.hljs-comment` → `--muted-foreground` italic

### 3.5 不允许的颜色用法

- 任何写死的渐变、彩色阴影。
- 用 `red-500` / `blue-600` 这类 Tailwind 调色板（避免主题切换时不变色）。
- 在 dark 模式下大块纯黑（`#000`），用 `--background`。

---

## 4. 排版

### 4.1 字体

- UI：`ui-sans-serif, system-ui, "Segoe UI", sans-serif`。
- 代码：`var(--font-mono)`，由 token 控制，用户可在外观里覆盖。
- 默认正文 14px / `text-sm` 是文档字号；标题 `text-base` ~ `text-xl`。
- 元数据 / chip / 时长用 `text-xs` 或 `text-[11px] / [10px]`。

### 4.2 行高 / 文本

- 段落 `leading-relaxed`；列表 `leading-relaxed`；UI 元素 `leading-none` 或 `leading-tight`。
- 长文本 `break-words`；路径 / id / 命令 `break-all` + `font-mono`。
- assistant 文本走 `react-markdown` (`AssistantMarkdown`)，**不允许** 直接 dump assistant text 进 `<pre>`。

---

## 5. 间距与节奏（间距是 codex vs codex 看着像不像的关键）

### 5.1 主区三段（流式视图）

- `MessageStream`：`px-6 py-6 max-w-3xl mx-auto gap-5` —— 这是消息流的"舒适宽度"，**不要** 拉到 `max-w-screen` 或加大 `gap-6+`。
- 主区 `ChatHeader`：`px-3 py-2`（更紧），**不再** 与消息流共享 `max-w-3xl mx-auto`。
- `Composer`：not-centered 时 `px-6 py-3`，内部 `max-w-3xl mx-auto`，与 MessageStream 内容对齐。
- **三块视觉不被分割线切开**：`Header` 不加 `border-b`、`Composer` 不加 `border-t`，靠 `bg-*` 区分。

### 5.2 消息内部

- block 之间 `gap-2`（MessageView）。
- RunGroup 步骤之间 `space-y-2`，与外层 message 节奏一致。
- 工具卡 `ExpandableRow` 展开内容 `mt-1.5` + `ml-5`，不再加额外 padding。
- 用户气泡 `px-3.5 py-2 rounded-2xl bg-muted`，不超过 `max-w-[80%]`。

### 5.3 Sidebar

- 顶部 `px-3 pt-3`，按钮 `h-8 px-2`。
- 项目行 `pl-1 pr-1 py-1.5`，子会话行缩进 `pl-6 pr-1 py-1`。
- 副信息 `text-[10px]`，**msg 数与时间用 `justify-between`** 分到两端，不要堆一行。
- 项目顺序按添加时间稳定排列（**不要** 因为选中 / 展开就 `touchProject` 让它跳到顶）。

### 5.4 设置页

- 三段式：`px-8 pt-8 pb-4 shrink-0` 标题 + `<ScrollArea className="flex-1 min-h-0">` 内容 + （可选）`px-8 py-4 shrink-0` 底部操作区。
- 标题 / 底部 **绝不** 用 sticky；ScrollArea 不要嵌 sticky。
- 标题区允许一行短描述（如「给 Claude CLI 设置网络代理，修改后下次启动会话生效」），**禁止** 多段说明 / 注释 / 解释 NO_PROXY 是什么这种长文。一句话讲清就停。

---

## 6. 文案规范

- **简明 > 详尽**。一句话能讲完的不要分两段；不要在 UI 里写"已写入 plan.md §X.Y"这类元说明。
- 中英文混排：技术名词保留英文（CLI / NO_PROXY / SOCKS5 / OAuth）；交互动词用中文（启用 / 保存 / 添加项目 / 置顶会话）。
- 状态文案：成功用 toast.success（句号结尾，简短），失败用 toast.error，附原始错误。
- 不要使用 emoji（除非用户在 issue / 文案里明确指定）。
- 占位符和示例只写代表性最强的：host placeholder `127.0.0.1`、port `7890`、NO_PROXY `localhost,127.0.0.1,::1`。

---

## 7. 流式渲染（Codex 风）

### 7.1 RunGroup 折叠卡

- 用户消息发出后立即 `ensureRun(m.ts)`，给一个空 run 占位 + 实时秒表（`处理中…`）。
- 同一轮内的 thinking / tool_use / tool_result 收纳到当前 run；assistant text 平铺到 run 之外。
- result 事件出现 → run.running=false + durationMs 来自 `result.duration_ms`；新一轮 user 消息出现也强制关闭前一段。
- **展开方向向上**：DOM 顺序 = `[内容区, trigger button]`，trigger 始终在底；折叠时按钮上方下边框跨容器全宽，展开时变成上边框。
- 时长格式（`fmtDuration`）：
  - <1s → `123ms`；流式整数秒 `3s 4s ...`；完成态正好整秒 `3s`，非整数 `3.4s`；分钟段 `1m05s`。
  - 显示口径：**优先用 `result.duration_ms`**（CLI Crunched 时长，含 TTFT 和末尾 text），其次再用 step 时间范围兜底。
  - 不允许显示 `0.0s` / `3.0s`。

### 7.2 RunGroup 标签

- 流式：`处理中…` / `处理中… 12s · 3 步`。
- 完成：`已处理 1m05s · 7 步` / 没时间数据时 `已处理 · 7 步`。
- `· N 步` 在 N=0 时省略整段。

### 7.3 卡片图标 / 文案

- 工具行采用动词态：`已运行 git status` / `已读取 README.md` / `已编辑 file.ts`。
- 流式中 verb 切换为「正在运行 / 正在读取 / 正在编辑」。
- 失败状态用 `text-destructive` + `AlertTriangle`。

---

## 8. 弹窗 / 模态

- 标题简短、动词开头：`添加项目` / `删除会话` / `重命名`。
- description 一句话讲必要操作（"选择目录或填入新路径，不存在会自动创建。"），不写 4 行教程。
- 操作按钮：主操作右、次操作左；主操作 `<Button>`、次操作 `<Button variant="ghost">`。
- 危险操作（删除）用 `variant="destructive"` 或 `text-destructive` 菜单项。
- Dialog 关闭：Esc + 右上 X + 点击外部。**不要** 自己拦 Esc 不让关。

---

## 9. 表单

- 行布局：`<Row label>...</Row>`，左侧 `Label className="w-16 text-xs shrink-0"`，右侧控件 `flex-1` 或定宽（端口 `w-32`）。
- 密码：`<Input type="password" />`，让浏览器 / 系统提供原生显示按钮，**不要** 手写 EyeOff 切换图标。
- 必填校验靠按钮 disabled 而非红框报错（除非真的发了请求才知道错）。
- 保存按钮：`<Button onClick={save} disabled={!dirty}>` + 旁边 dirty 时显示 `<span className="text-xs text-warn">有未保存的修改</span>`。

---

## 10. 边界 / 状态

- 空态：居中 `MessageSquareDashed` 大图标 + 一句话提示。文案口径：`输入消息开始对话` / `暂无项目，点击 + 添加`。
- loading：用 `<Loader2 className="size-3.5 animate-spin" />`，**不要** 自定义 svg spinner。
- 错误：`text-destructive` + `AlertTriangle`，break-all 显示原始错误信息，不吞错。
- 历史 jsonl 不带 `result` 行 → 不强造一个假的；显示 `已处理 · N 步` 即可。

---

## 11. 图标

- 全部走 `lucide-react`，named import。
- 默认尺寸通过 button class 自动 `[&_svg]:size-4` 控制；自定义场景显式 `size-3` / `size-3.5` / `size-4`。
- 不要混用其他图标库；不要把 emoji 当图标用。

---

## 12. 数据持久化命名

- localStorage key 一律 `claudinal.<feature>`（新加；旧的 `claudecli.*` 保留兼容）。
- 同一类型只允许有一个 store 文件（如 pinned 在 `lib/pinned.ts`）。
- 写入要 `try/catch + 兜底`，读取失败返回默认值 + 不抛。

---

## 13. 可访问性 / 键盘

- 所有图标按钮加 `aria-label`。
- Composer：Enter 发送、Shift+Enter 换行、Esc 中断。
- 全局：`Ctrl+O` 添加项目；后续新增 shortcut 必须写到本节追加表里。
- 折叠 / 弹窗 trigger 必须有 `aria-expanded` / Radix 自动管理。

---

## 14. 不做清单（避免无意走偏）

- 自定义 confirm 对话框（先用 `window.confirm`，UX 不好再升）。
- 自带浏览器环境（仅通过 CLI 自带 MCP）。
- 重新实现 thinking / tool 过程（reducer 只搬运，不解释 agent 行为）。
- 自研图表 / 终端模拟器。
- 把 jsonl 当全量真相重新写回（永远只读取，写持久化用我们自己的 sidecar 文件）。

---

## 15. 代码层面 SOP

- 路径别名 `@/*`，不要写相对路径深过 2 级。
- 组件文件 PascalCase；hook / lib camelCase；类型用 `interface` 优先（除联合类型用 `type`）。
- React 19，**不要** 写 `forwardRef` / `memo` 除非有性能证据。
- 不写多行注释 / docstring；只在「为什么」非显而易见时写一行注释。
- 不引入新依赖前先确认 shadcn / Radix 是否已经能解决；新依赖必须写到 plan.md 依赖表。

---

## 16. 提交前自检（30 秒）

1. 是不是把已有 shadcn primitive 复刻了一遍？
2. 是不是写了 hex / Tailwind 调色板（`red-500` / `gray-200`）？
3. 是不是加了多段说明文字？
4. 是不是把 Sidebar 项目顺序搞跳了 / 把 Header / Composer 拼了边框？
5. 主区流式宽度是不是 `max-w-3xl mx-auto`？RunGroup 是不是向上展开 + 跨宽边框？
6. 时长格式是不是 `3.0s` / `0ms` 这种异常显示？
7. 设置页是不是变成了一坨长说明文档？
