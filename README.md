# Claudinal

> 一个为 Claude CLI 量身定制的高颜值桌面外壳。

**核心理念：不重造 Agent，只造一个比 TUI 更好用的外壳。**
本项目通过 Tauri 2 包装本地的 `claude` CLI headless stream-json 接口，将底层的 Prompt、工具调度和 Hook 执行完全交由原生的 Claude CLI 负责。CLI 升级，桌面端即刻自动获得新能力。

## ✨ 核心特性

- **极致的流式渲染**：沉浸式的 Markdown 对话体验，逐字渲染，平滑过渡。
- **Codex 风格会话管理**：清晰的本地项目分组、历史对话检索与状态追踪。
- **参数可视化面板**：可视化调节 Model / Effort / Permission Mode 以及预算成本，并实时生效。
- **结构化消息卡片**：告别杂乱的终端输出，思考过程 (Thinking)、工具调用 (Bash/Edit/Read) 均采用独立优雅的折叠卡片与 Diff 视图展示。
- **原生能力加持**：无缝支持系统文件拖拽粘贴、本地代理设置及深浅色主题自由切换。

## 🛠️ 技术栈

- **外壳与后端**：Tauri 2 + Rust (子进程管理 + SQLite 会话索引)
- **前端界面**：React 19 + TypeScript + Zustand
- **UI 框架**：shadcn/ui + Tailwind CSS v4 + lucide-react

## 🚀 快速开始

### 前置要求
1. 本机已安装并配置好官方的 `claude` CLI（≥ 2.1.x）。
2. Node.js 及 `pnpm` 包管理器。
3. Rust 编译环境。

### 本地运行

```bash
# 克隆仓库
git clone https://github.com/your-username/claudinal.git
cd claudinal

# 安装依赖
pnpm install

# 启动开发环境
pnpm tauri dev

# 打包构建
pnpm tauri build
```

## 📜 协议 (License)

本项目采用 **GNU AGPLv3** 开源协议。

AGPLv3 旨在保障用户的网络端使用自由，并促进开源社区的繁荣：
- 允许免费用于个人、学术及商业用途。
- 允许修改源码，但**任何基于本项目的修改及衍生作品，必须同样以 AGPLv3 协议开源**。
- 如果您将此项目部署为网络服务（哪怕用户没有直接获取代码），**也必须向用户提供该服务的完整源代码**。

> ⚠️ **关于商业闭源使用的特别说明**：
> 只要您遵守 AGPLv3 协议开源您的修改与衍生代码，您完全可以进行商业化。但如果您希望将本项目嵌入到您的**闭源商业产品**中，这是**被严格禁止的**。
