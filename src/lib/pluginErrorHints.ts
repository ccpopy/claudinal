// 插件 / Marketplace 安装、刷新失败时的可读诊断。
// 输入：从 stderr 或后端 Error 拿到的字符串；
// 输出：一行简明 summary + 若干条可执行 hint。
//
// 不调命令、不动 IPC，仅做文本模式匹配。模式来自常见 git / npm / curl 错误。

export interface PluginErrorHint {
  /** 触发的关键词或场景，便于在 UI 里高亮 */
  topic: string
  /** 一行可读建议 */
  message: string
}

export interface PluginErrorAnalysis {
  /** 一行总结，UI 会作为 toast 标题；不带「：」之类的口语词 */
  summary: string
  /** 原始错误（已 trim）；UI 用 mono 字体展示 */
  raw: string
  /** 可读建议清单 */
  hints: PluginErrorHint[]
}

interface Pattern {
  keywords: RegExp
  topic: string
  message: string
}

const PATTERNS: Pattern[] = [
  {
    keywords: /could not read username|terminal prompts disabled|authentication failed/i,
    topic: "git 凭据",
    message:
      "Git 在非交互模式下需要凭据。配置 git credential helper（macOS 用 osxkeychain，Windows 用 manager-core），或改用 SSH URL。"
  },
  {
    keywords: /permission denied \(publickey\)|host key verification failed|ssh-agent/i,
    topic: "SSH 公钥",
    message:
      "SSH 鉴权失败。运行 `ssh-add` 加载私钥，或在 ~/.ssh/config 中指定 IdentityFile；GitHub 可用 `ssh -T git@github.com` 自检。"
  },
  {
    keywords: /403 forbidden|401 unauthorized|requires authentication/i,
    topic: "HTTPS 鉴权",
    message:
      "私有仓库需要鉴权。执行 `gh auth login` 获取 token，或在 ~/.gitconfig 中配置 credential helper。"
  },
  {
    keywords: /could not resolve host|network is unreachable|getaddrinfo|enotfound/i,
    topic: "网络",
    message:
      "无法解析目标地址。检查 DNS 和网络代理；内网环境需在「设置 -> 网络代理」中配置代理后重试。"
  },
  {
    keywords: /timed out|operation timed out|etimedout|timeout/i,
    topic: "网络超时",
    message:
      "请求超时。代理可能未配置或目标站点限流；测试代理连通后再重试。"
  },
  {
    keywords: /tls handshake|certificate|x509|self[- ]signed/i,
    topic: "TLS 证书",
    message:
      "TLS 证书校验失败。企业网络可能注入了自签名 CA；将证书加入系统信任链，或通过 git http.sslCAInfo 指定 CA bundle。"
  },
  {
    keywords: /not found|repository not found|404/i,
    topic: "仓库不存在",
    message:
      "目标仓库或 Marketplace 标识不存在。核对拼写和大小写，或检查仓库是否私有需要鉴权。"
  },
  {
    keywords: /eacces|eperm|permission denied/i,
    topic: "文件权限",
    message:
      "目录写入被拒。确认 ~/.claude/plugins 和 ~/.claude/marketplaces 可写；如果使用过 sudo 安装，可能需要 chown 回当前用户。"
  },
  {
    keywords: /enospc/i,
    topic: "磁盘空间",
    message: "磁盘空间不足。清理后再重试。"
  },
  {
    keywords: /command not found|enoent.*claude|claude: not found|找不到/i,
    topic: "Claude CLI",
    message:
      "未找到 Claude CLI。确认 PATH 中包含 `claude --version`，或设置 CLAUDE_CLI_PATH 环境变量。"
  },
  {
    keywords: /git: not found|git command not found|enoent.*git/i,
    topic: "Git",
    message: "未找到 Git。安装 Git 并确保在 PATH 中。"
  }
]

const FALLBACK_HINT: PluginErrorHint = {
  topic: "通用",
  message:
    "可在 plan.md 或 Marketplace 仓库 issue 中搜索类似错误，或到「设置 -> MCP 服务器」「网络代理」核对相关配置。"
}

export function analyzePluginError(
  action: string,
  error: unknown
): PluginErrorAnalysis {
  const raw = errorMessage(error)
  const hits: PluginErrorHint[] = []
  const seen = new Set<string>()
  for (const pattern of PATTERNS) {
    if (pattern.keywords.test(raw)) {
      if (seen.has(pattern.topic)) continue
      seen.add(pattern.topic)
      hits.push({ topic: pattern.topic, message: pattern.message })
    }
  }
  if (hits.length === 0) hits.push(FALLBACK_HINT)
  const summary = hits.length === 1 && hits[0] === FALLBACK_HINT
    ? `${action}失败`
    : `${action}失败：${hits.map((h) => h.topic).join(" / ")}`
  return {
    summary,
    raw: raw.trim(),
    hints: hits
  }
}

function errorMessage(error: unknown): string {
  if (error == null) return ""
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return ""
  }
}
