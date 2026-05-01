// 轻量配置事件总线 — 解决"Settings 改了，多个消费者不知道何时该重读"的耦合。
//
// 设计约束：
// - 仅广播"该 topic 下数据已变更"的信号，不携带载荷；订阅方按需调用 load*() 重读。
// - 同步分发，遍历 Set 调用回调，单 topic 订阅者保持在两位数以内。
// - 订阅回调只负责触发消费方刷新；重的 IO 仍由消费方自己的 load*() 承担。
// - 无优先级、无中断、无去抖：这些都属于过度设计，没有实际场景需要。
//
// Topic 列表是封闭枚举：新增 topic 必须在这里登记，避免拼写错产生隐形耦合。

export type SettingsBusTopic =
  | "settings"
  | "composerPrefs"
  | "thirdPartyApi"
  | "proxy"
  | "appearance"
  | "usage"

const subs = new Map<SettingsBusTopic, Set<() => void>>()

export function emitSettingsBus(topic: SettingsBusTopic): void {
  const set = subs.get(topic)
  if (!set || set.size === 0) return
  for (const fn of set) {
    try {
      fn()
    } catch (error) {
      console.error(`[settingsBus] ${topic} subscriber failed`, error)
    }
  }
}

export function subscribeSettingsBus(
  topic: SettingsBusTopic,
  fn: () => void
): () => void {
  let set = subs.get(topic)
  if (!set) {
    set = new Set()
    subs.set(topic, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
  }
}
