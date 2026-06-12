export interface TriggerInfo {
  kind: "@" | "/"
  /** 触发字符在文本中的位置 */
  start: number
  /** 触发字符与光标之间的查询串 */
  query: string
}

export function parseTrigger(text: string, caret: number): TriggerInfo | null {
  // 从光标向前找最近的 @ 或 /，遇到空白或越界则停。
  let i = caret - 1
  while (i >= 0) {
    const c = text[i]
    if (c === "@" || c === "/") {
      // 触发符前必须是行首或空白（避免 a/b 触发）
      const prev = i > 0 ? text[i - 1] : "\n"
      if (prev === " " || prev === "\n" || prev === "\t" || i === 0) {
        return {
          kind: c as "@" | "/",
          start: i,
          query: text.slice(i + 1, caret)
        }
      }
      return null
    }
    if (c === " " || c === "\n") return null
    i--
  }
  return null
}

/**
 * 触发签名：kind + start + query 任一变化即视为新触发。
 *
 * Composer 用它判断是否把候选高亮重置回第 0 项——同签名的重复刷新
 * （keyup 重新评估、异步文件补全结果返回）不得清掉用户用 ↑↓ 选中的位置；
 * 签名变化（继续输入字符、光标移动改变 query）才回到首项。
 *
 * 分隔符用 ":"：kind 是定长单字符、start 是纯数字（不含 ":"），因此
 * 第一个 ":" 之前必为 kind、第二个 ":" 之前必为完整的 start，签名相等
 * 当且仅当三个字段全部相等（query 含 ":" 也不会产生拼接歧义，例如
 * start=1,query="2" 与 start=12,query="" 的签名分别为 "/:1:2" 与 "/:12:"）。
 */
export function triggerSignature(info: TriggerInfo): string {
  return [info.kind, String(info.start), info.query].join(":")
}
