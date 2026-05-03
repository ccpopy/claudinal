// 会话期间的网络错误识别。
// 当 Claude CLI / sidecar proxy 把网络故障写到 stderr 或返回带 is_error 的 result 时，
// GUI 默认会把行追加到对话流末尾；但用户滚动时容易错过，且代理失效后没有任何 toast。
// 这里集中识别常见网络模式，给一行可读 summary + 一条建议，由调用方决定是否弹 toast。
//
// 仅做文本模式匹配；不调命令、不动 IPC。模式来自 reqwest / hyper / curl / Anthropic CLI 常见错误。

export type NetworkErrorTopic =
  | "proxy"
  | "tls"
  | "dns"
  | "timeout"
  | "refused"
  | "rate-limit"
  | "auth"
  | "server-5xx"

export interface NetworkErrorHit {
  topic: NetworkErrorTopic
  /** 一行总结，作为 toast 标题 */
  summary: string
  /** 建议 / 修复方向 */
  hint: string
}

interface Pattern {
  topic: NetworkErrorTopic
  keywords: RegExp
  summary: string
  hint: string
}

const PATTERNS: Pattern[] = [
  {
    topic: "proxy",
    // 命中 proxy 关键词 + 任一失败信号；避免误命中纯包含 "proxy" 的正常日志
    keywords:
      /(proxy[a-z ]*?(error|connect|tunnel|authentication|fail|refus)|connect to .* via proxy|HTTP\/1\.1 502 .*proxy)/i,
    summary: "代理连接异常",
    hint:
      "代理访问失败。打开「网络代理」页测试连接；常见原因：代理地址错误、代理服务未运行、鉴权密码丢失、settings.json 中残留旧代理变量。"
  },
  {
    topic: "tls",
    keywords:
      /(tls handshake|certificate verify|x509|self[- ]signed|sslv3 alert|unable to get local issuer|cert.*invalid|cert.*expired|ssl: certificate)/i,
    summary: "TLS 证书校验失败",
    hint:
      "企业网络可能注入了自签名 CA。将代理或网关的 CA 证书加入系统信任链，或通过 ANTHROPIC_BETA / NODE_EXTRA_CA_CERTS 指定 CA bundle。"
  },
  {
    topic: "dns",
    keywords:
      /(could not resolve host|name or service not known|getaddrinfo (failed|enotfound)|enotfound|dns resolution failed|temporary failure in name resolution)/i,
    summary: "DNS 解析失败",
    hint:
      "无法解析目标域名。检查本机 DNS 和网络连通性；内网环境需在「网络代理」页配置代理后重试。"
  },
  {
    topic: "timeout",
    keywords:
      /(timed out|operation timed out|etimedout|read timed out|connect ?timed?out|deadline exceeded|request timeout)/i,
    summary: "请求超时",
    hint:
      "目标响应过慢或被网关拦截。在「网络代理」页测试连通性；代理正常则可能是远端临时拥塞，稍后重试。"
  },
  {
    topic: "refused",
    keywords:
      /(connection refused|econnrefused|connection reset|econnreset|broken pipe|network is unreachable|enetunreach|no route to host|tunnel connection failed)/i,
    summary: "连接被拒绝 / 中断",
    hint:
      "目标地址不可达或代理拒绝连接。确认代理地址和端口正确、代理进程正在运行；如果开启了系统级 VPN，注意其可能绕过 HTTP 代理。"
  },
  {
    topic: "rate-limit",
    keywords:
      /(rate ?limit|too many requests|http\s*status\s*429|429 too many)/i,
    summary: "触发了速率限制",
    hint:
      "Anthropic 端限流。等待速率窗口重置后重试；OAuth 用户可在「账户和使用情况」查看当前限额。"
  },
  {
    topic: "auth",
    keywords:
      /(http\s*status\s*401|http\s*status\s*403|401 unauthorized|403 forbidden|unauthorized|invalid api key|authentication.*fail|missing.*api ?key)/i,
    summary: "鉴权失败",
    hint:
      "API Key 或 OAuth token 无效。第三方 API 用户检查 Key 是否过期；OAuth 用户可在「账户」页重新登录。"
  },
  {
    topic: "server-5xx",
    keywords: /(http\s*status\s*5\d\d|5\d\d (internal|bad gateway|gateway timeout|service unavailable))/i,
    summary: "上游服务器错误",
    hint:
      "Anthropic 或第三方代理返回 5xx，通常是临时故障。稍后重试；反复出现则检查「网络代理」页，确认代理本身是否返回了 502/503。"
  }
]

export function detectNetworkError(
  raw: string | null | undefined
): NetworkErrorHit | null {
  if (!raw) return null
  const text = String(raw).trim()
  if (!text) return null
  for (const pattern of PATTERNS) {
    if (pattern.keywords.test(text)) {
      return {
        topic: pattern.topic,
        summary: pattern.summary,
        hint: pattern.hint
      }
    }
  }
  return null
}
