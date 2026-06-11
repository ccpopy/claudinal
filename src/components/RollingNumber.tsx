import { useEffect, useRef, useState } from "react"

/**
 * 数字滚动：值变化时旧值上滚出、新值下滚入（动画类
 * diff-number-old / diff-number-new 定义在全局样式里）。
 * 从 RunReviewCard 提取共享，渲染结果与提取前一致。
 */
export function RollingNumber({
  value,
  prefix = ""
}: {
  value: number
  prefix?: string
}) {
  const previousRef = useRef(value)
  const [previous, setPrevious] = useState(value)
  const [rolling, setRolling] = useState(false)

  useEffect(() => {
    if (previousRef.current === value) return
    setPrevious(previousRef.current)
    previousRef.current = value
    setRolling(true)
    const timeout = window.setTimeout(() => setRolling(false), 220)
    return () => window.clearTimeout(timeout)
  }, [value])

  const text = `${prefix}${value}`
  if (!rolling) return <span className="tabular-nums">{text}</span>

  return (
    <span className="relative inline-flex h-[1.15em] min-w-[2ch] overflow-hidden align-[-0.14em] tabular-nums">
      <span className="diff-number-old absolute inset-x-0 top-0">
        {prefix}
        {previous}
      </span>
      <span className="diff-number-new absolute inset-x-0 top-0">{text}</span>
      <span className="invisible">{text}</span>
    </span>
  )
}
