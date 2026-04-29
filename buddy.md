2026 年愚人节，[Anthropic](https://zhida.zhihu.com/search?content_id=272383148&content_type=Article&match_order=1&q=Anthropic&zd_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ6aGlkYV9zZXJ2ZXIiLCJleHAiOjE3Nzc2NDE0NTgsInEiOiJBbnRocm9waWMiLCJ6aGlkYV9zb3VyY2UiOiJlbnRpdHkiLCJjb250ZW50X2lkIjoyNzIzODMxNDgsImNvbnRlbnRfdHlwZSI6IkFydGljbGUiLCJtYXRjaF9vcmRlciI6MSwiemRfdG9rZW4iOm51bGx9.RbKAvVEhWqkmj72YsmwXQYIzPUwo1Um7Eq9KZj7n9AA&zhida_source=entity) 在 [Claude Code](https://zhida.zhihu.com/search?content_id=272383148&content_type=Article&match_order=1&q=Claude+Code&zd_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ6aGlkYV9zZXJ2ZXIiLCJleHAiOjE3Nzc2NDE0NTgsInEiOiJDbGF1ZGUgQ29kZSIsInpoaWRhX3NvdXJjZSI6ImVudGl0eSIsImNvbnRlbnRfaWQiOjI3MjM4MzE0OCwiY29udGVudF90eXBlIjoiQXJ0aWNsZSIsIm1hdGNoX29yZGVyIjoxLCJ6ZF90b2tlbiI6bnVsbH0.IDbLqJhgw4sra4q7E_QdhAKgQ-BMs5h5wb79zs8Mgbg&zhida_source=entity) v2.1.88 中悄悄塞了一个彩蛋 —— 输入 `/buddy`，一只 [ASCII 小生物](https://zhida.zhihu.com/search?content_id=272383148&content_type=Article&match_order=1&q=ASCII+小生物&zd_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ6aGlkYV9zZXJ2ZXIiLCJleHAiOjE3Nzc2NDE0NTgsInEiOiJBU0NJSSDlsI_nlJ_niakiLCJ6aGlkYV9zb3VyY2UiOiJlbnRpdHkiLCJjb250ZW50X2lkIjoyNzIzODMxNDgsImNvbnRlbnRfdHlwZSI6IkFydGljbGUiLCJtYXRjaF9vcmRlciI6MSwiemRfdG9rZW4iOm51bGx9.Si5un80pywdoFgSb66h7YQ4ROigDwUUmnWF4T_RKxeg&zhida_source=entity)就会从蛋壳里蹦出来，从此坐在你的终端旁边，看你写代码，偶尔吐槽两句。这篇文章从玩法到源码，完整拆解这个藏在命令行里的电子宠物。

### 一、玩法全指南

### 1.1 孵化你的宠物

在 Claude Code 终端中输入 `/buddy`，即可孵化专属于你的电子宠物。

> **注意**：宠物的物种、稀有度、眼睛、帽子等外观属性由你的 **用户 ID 哈希值**确定性生成，意味着同一个账号永远孵出同一只宠物，无法重新抽卡。

首次孵化时，Claude 会为你的宠物生成一个名字和性格描述（即”灵魂”），这是唯一由 AI 创造的部分。之后每次打开 Claude Code，它就会自动出现在输入框旁边。

**首次启动的发现流程：**

如果你还没孵化宠物，在 2026 年 4 月 1-7 日期间启动 Claude Code 时，底部会出现一行彩虹色的 `/buddy` 提示文字，持续 15 秒后消失。这是引导你发现这个隐藏功能的入口。

### 1.2 宠物物种图鉴

一共有 **18 种物种**，每种都有独特的 ASCII 造型：



![img](https://pic2.zhimg.com/v2-0315bf07ba8005f9276f6126f3f443d1_1440w.jpg)



### 1.3 稀有度体系



![img](https://pic1.zhimg.com/v2-788567e1cf898b849234a6fa0a511688_1440w.jpg)



不同稀有度的视觉差异：



![img](https://pic1.zhimg.com/v2-2836b876388442ee7a338c512e75f73c_1440w.jpg)



**帽子种类**（Common 没有帽子，其余稀有度随机分配）：



![img](https://picx.zhimg.com/v2-0932b8cb0fc15fcea59482bb9a4083b1_1440w.jpg)



此外还有 **1% 概率**出现 **Shiny（闪光版）**，属于隐藏收集要素。

### 1.4 五维属性系统

每只宠物拥有 5 项 RPG 风格的属性值：



![img](https://pic4.zhimg.com/v2-a351ab5cf02ad3e394a81f1482b425f1_1440w.jpg)



属性生成规则：

- 每只宠物有一项 **峰值属性**（下限 + 50 + 随机 0~30）
- 一项 **低谷属性**（下限 - 10 + 随机 0~15）
- 其余属性散布在下限 + 随机 0~40 范围

这意味着每只宠物都有鲜明的”性格长板”和”性格短板”。

### 1.5 交互命令



![img](https://pic2.zhimg.com/v2-9af8bad810484ac04ee28c2620995317_1440w.jpg)



**抚摸特效动画帧：**

```text
♥    ♥      ← 第 1 帧
  ♥  ♥   ♥     ← 第 2 帧
 ♥   ♥  ♥      ← 第 3 帧
♥  ♥      ♥    ← 第 4 帧
·    ·   ·     ← 第 5 帧（消散）
```

### 1.6 宠物反应系统

每次 Claude 完成一轮回复后，宠物会”观察”整段对话，然后在气泡框里给出一句话反应。

**气泡生命周期：**

- 出现后持续 **约 10 秒**（20 个 500ms tick）
- 最后 **约 3 秒**开始淡出（文字变暗）
- 用户滚动屏幕时**立即消失**（避免遮挡内容）
- 宠物说话时精灵进入**激动模式**（快速切换帧）

### 1.7 与 Claude 的互动

宠物的存在会被注入到 Claude 的 system prompt 中，Claude 知道用户旁边坐着一只小动物。

- 用户直接 **叫宠物的名字** 时，气泡会自己回应
- 此时 Claude 会**主动退让**，只用一行或更少的文字回应
- Claude 不会假装自己是宠物，也不会代替宠物说话

### 1.8 终端适配



![img](https://pic3.zhimg.com/v2-2ea992bd18a2f6f6ca28b5ef27852eda_1440w.jpg)



------

### 二、技术架构

### 2.1 系统总览



![img](https://pic4.zhimg.com/v2-c9e2f6590a59412e5264b4750d984525_1440w.jpg)



### 2.2 源码文件清单



![img](https://pic1.zhimg.com/v2-f5e5778dc3d1a114582e2ceba352866e_1440w.jpg)



### 2.3 确定性角色生成

这是整个系统最精妙的部分——**同一个用户永远得到同一只宠物**，不依赖随机数，不需要服务端存储。



![img](https://pic4.zhimg.com/v2-a3810655abdf61d9b617ae08c131f36b_1440w.jpg)



**关键算法：**

**1) [FNV-1a 哈希](https://zhida.zhihu.com/search?content_id=272383148&content_type=Article&match_order=1&q=FNV-1a+哈希&zd_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ6aGlkYV9zZXJ2ZXIiLCJleHAiOjE3Nzc2NDE0NTgsInEiOiJGTlYtMWEg5ZOI5biMIiwiemhpZGFfc291cmNlIjoiZW50aXR5IiwiY29udGVudF9pZCI6MjcyMzgzMTQ4LCJjb250ZW50X3R5cGUiOiJBcnRpY2xlIiwibWF0Y2hfb3JkZXIiOjEsInpkX3Rva2VuIjpudWxsfQ.SQ8naZf73j4dJshrsKZjsI696mM7IgIArYXO9L6FosY&zhida_source=entity)**（将字符串转为 32 位整数种子）：

```text
function hashString(s: string): number {
  // Bun 环境用原生 Bun.hash
  if (typeof Bun !== 'undefined') {
    return Number(BigInt(Bun.hash(s)) & 0xffffffffn)
  }
  // 回退到手写 FNV-1a
  let h = 2166136261  // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)  // FNV prime
  }
  return h >>> 0
}
```

**2) Mulberry32 PRNG**（从种子生成伪随机序列）：

```text
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
```

**3) 加权稀有度 Roll**：

```text
// RARITY_WEIGHTS: common=60, uncommon=25, rare=10, epic=4, legendary=1
function rollRarity(rng: () => number): Rarity {
  const total = 100  // 60+25+10+4+1
  let roll = rng() * total
  for (const rarity of RARITIES) {
    roll -= RARITY_WEIGHTS[rarity]
    if (roll < 0) return rarity
  }
  return 'common'
}
```

### 2.4 持久化策略



![img](https://pic2.zhimg.com/v2-8667e10b14a59a530b9da6d5dc2c2d85_1440w.jpg)



> **防作弊设计**：[Bones](https://zhida.zhihu.com/search?content_id=272383148&content_type=Article&match_order=1&q=Bones&zd_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ6aGlkYV9zZXJ2ZXIiLCJleHAiOjE3Nzc2NDE0NTgsInEiOiJCb25lcyIsInpoaWRhX3NvdXJjZSI6ImVudGl0eSIsImNvbnRlbnRfaWQiOjI3MjM4MzE0OCwiY29udGVudF90eXBlIjoiQXJ0aWNsZSIsIm1hdGNoX29yZGVyIjoxLCJ6ZF90b2tlbiI6bnVsbH0.RDwlHlU9kRFr3LOsTlCGFiwyWbl4c7yEZZU-Xyfw21Y&zhida_source=entity)（物种、稀有度等）永远不写入配置文件，每次从 userId 重算。用户即使手动编辑 config.json，也无法伪造一只 Legendary 宠物。存储的只有 AI 生成的名字和性格。

```text
// 读取时：骨骼重算 + 灵魂从存储加载
export function getCompanion(): Companion | undefined {
  const stored = getGlobalConfig().companion
  if (!stored) return undefined
  const { bones } = roll(companionUserId())
  return { ...stored, ...bones }  // bones 覆盖 stored 中的旧字段
}
```

**热路径缓存**：`roll()` 结果缓存在内存中，因为它会在三个高频路径被调用：



![img](https://pic1.zhimg.com/v2-22c322c20002ab92316d7ad002df9b40_1440w.jpg)



### 2.5 ASCII 精灵动画系统

每个物种有 **3 帧** ASCII 动画，每帧 **5 行 × 12 列**：

```text
帧 0（静止）      帧 1（微动）      帧 2（特殊）
   /\_/\            /\_/\            /\-/\
  ( ·   ·)         ( ·   ·)         ( ·   ·)
  (  ω  )          (  ω  )          (  ω  )
  (")_(")          (")_(")~         (")_(")
                   ^尾巴甩           ^耳朵抖
```

**动画状态机：**



![img](https://pic4.zhimg.com/v2-e49dfca96a10eec54e9c7d473348343f_1440w.jpg)



**闲置序列精确定义：**

```text
const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0]
// 索引:              0  1  2  3  4  5  6  7   8  9 10 11 12 13 14
// 含义: 静 静 静 静 抖 静 静 静 眨眼 静 静 特殊 静 静 静
```

- `0` = 静止帧
- `1` / `2` = 对应的动画帧
- `-1` = 眨眼（在帧 0 基础上把眼睛字符替换为 `-`）

15 帧一个循环，500ms 一跳，完整周期 **7.5 秒**。

**帽子渲染规则：**

```text
// 帽子渲染在精灵第 0 行（仅当该行为空时）
if (bones.hat !== 'none' && !lines[0]!.trim()) {
  lines[0] = HAT_LINES[bones.hat]
}
// 如果所有帧的第 0 行都为空且无帽子，则移除该行（节省垂直空间）
if (!lines[0]!.trim() && frames.every(f => !f[0]!.trim())) 
  lines.shift()
```

### 2.6 [React 组件层次](https://zhida.zhihu.com/search?content_id=272383148&content_type=Article&match_order=1&q=React+组件层次&zd_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ6aGlkYV9zZXJ2ZXIiLCJleHAiOjE3Nzc2NDE0NTgsInEiOiJSZWFjdCDnu4Tku7blsYLmrKEiLCJ6aGlkYV9zb3VyY2UiOiJlbnRpdHkiLCJjb250ZW50X2lkIjoyNzIzODMxNDgsImNvbnRlbnRfdHlwZSI6IkFydGljbGUiLCJtYXRjaF9vcmRlciI6MSwiemRfdG9rZW4iOm51bGx9.e8hym7ajDdZKQmur8olikIue9GzvE-QICkhUY1rLioI&zhida_source=entity)



![img](https://pic2.zhimg.com/v2-e3d7b2f90a5d8b4e6e1682b4976aad6d_1440w.jpg)



### 2.7 输入框宽度预留

宠物精灵和气泡需要在输入框旁边占据空间，[PromptInput](https://zhida.zhihu.com/search?content_id=272383148&content_type=Article&match_order=1&q=PromptInput&zd_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ6aGlkYV9zZXJ2ZXIiLCJleHAiOjE3Nzc2NDE0NTgsInEiOiJQcm9tcHRJbnB1dCIsInpoaWRhX3NvdXJjZSI6ImVudGl0eSIsImNvbnRlbnRfaWQiOjI3MjM4MzE0OCwiY29udGVudF90eXBlIjoiQXJ0aWNsZSIsIm1hdGNoX29yZGVyIjoxLCJ6ZF90b2tlbiI6bnVsbH0.Gag8mmwxj6eYovk78YG2wg0hWtmEQOgVNjskaglaKFA&zhida_source=entity) 通过 `companionReservedColumns()` 动态计算预留宽度：

```text
// PromptInput.tsx
const companionSpeaking = useAppState(s => s.companionReaction !== undefined)
const textInputColumns = columns - 3 
  - companionReservedColumns(columns, companionSpeaking)
```

**宽度预留公式：**



![img](https://pica.zhimg.com/v2-b48f12ace07afd1eaf129f5abe41d5b4_1440w.jpg)



### 2.8 气泡组件生命周期



![img](https://pic1.zhimg.com/v2-45a495d11fcdb57b9c64c448233d4826_1440w.jpg)



**滚动时的气泡处理：**

```text
// REPL.tsx — 用户滚动时立即清除气泡
if (feature('BUDDY')) {
  setAppState(prev => prev.companionReaction === undefined 
    ? prev 
    : { ...prev, companionReaction: undefined })
}
```

### 2.9 Prompt 注入机制

宠物通过 `companion_intro` 附件类型注入 system prompt：



![img](https://pic2.zhimg.com/v2-cf397206cb723b79e403376129b2c5f3_1440w.jpg)



注入的文本模板：

```text
A small {species} named {name} sits beside the user's 
input box and occasionally comments in a speech bubble. 
You're not {name} — it's a separate watcher.

When the user addresses {name} directly (by name), its 
bubble will answer. Your job in that moment is to stay 
out of the way: respond in ONE line or less.
```

**去重逻辑**：遍历消息历史，如果已有同名 `companion_intro` 附件就跳过，避免每轮重复注入。

### 2.10 Feature Gate 与编译时剥离

整个 Buddy 系统被 `feature('BUDDY')` 包裹，这是 Bun 打包器的**编译时常量**：

```text
// 编译时求值，未启用时整个代码块被 tree-shaking 移除
if (feature('BUDDY')) {
  // ... 所有 buddy 相关代码
}
```

**上线时间控制：**



![img](https://pic1.zhimg.com/v2-2e43c9d4ea53bed90d528bcba838463c_1440w.jpg)



> 使用**本地时间**而非 UTC，这样全球用户的 “发现时刻” 分布在 24 小时内，Twitter 话题热度更持久，服务端 soul 生成的负载也更平滑。

### 2.11 物种名编码彩蛋

源码中所有物种名都用 `String.fromCharCode()` 编码：

```text
export const duck = c(0x64,0x75,0x63,0x6b) as 'duck'
export const goose = c(0x67,0x6f,0x6f,0x73,0x65) as 'goose'
// ... 18 种全部如此
```

原因是 CI 中有 `excluded-strings.txt` 敏感字符串扫描——某个物种名恰好是一个模型代号的 canary 字符串。编码后源码不包含该字面量，CI 检查通过，但运行时行为完全正常。

------

### 三、设计亮点总结

### 3.1 架构决策



![img](https://pic1.zhimg.com/v2-a131028be5144eb7bf933d6e603fc32a_1440w.jpg)



### 3.2 数据流全景



![img](https://pic1.zhimg.com/v2-ef078566a6cc4bc633f44a01214e2ce0_1440w.jpg)



------

### 四、总结

Claude Code Buddy 是一个完整度极高的终端电子宠物系统：

- **18 种物种** × **6 种眼睛** × **8 种帽子** × **5 级稀有度** × **1% 闪光率** = 数千种组合
- 确定性生成保证**一人一宠**，防作弊且无服务端依赖
- ASCII 动画在 7.5 秒周期内自然流畅
- 全屏/普通/窄终端三种布局**无缝适配**
- AI 驱动的反应系统让宠物真正在”看你写代码”
- 编译时 feature gate 保证**零成本禁用**

它不只是一个愚人节彩蛋，而是一个经过严肃工程设计的终端伴侣系统。