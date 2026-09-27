/**
 * Markdown —— 手机端消息正文渲染（M5）。
 *
 * 为什么与桌面**同源**（都用 `react-markdown` + `remark-gfm`）：两端渲染的是同一份模型输出。
 * 若一端解析、一端不解析，同一段文字在手机与电脑上会长得不一样（尤其是代码块与嵌套列表），
 * 排障时无法对照，用户也会以为「两端看到了不同的回答」。
 *
 * ⚡ **流式性能（三级）**：
 *  1. **定时器节流**（`useThrottledContent`）—— 把高频 chunk 合并到**最多每 `STREAM_RENDER_MS`
 *     一次**（不依赖 rAF，见下方「为什么不用 rAF」）；
 *  2. **memo 渲染体**（`MarkdownBody`）—— 显示内容没推进就不解析；
 *  3. **前缀冻结**（`splitStablePrefix`）—— 每帧只重建「正在增长的尾部」。
 *
 * ⚠️ 为什么**只有 rAF 节流是不够的**（2026-09-29 真机缺陷，见 §29）：
 *   旧实现用 `requestAnimationFrame`，且闸门是「有没有一个 rAF 在排队」
 *   （`if (rafRef.current == null)`）。而 `main.tsx` 常驻 `<StrictMode>`，dev 下 React 会
 *   「挂载 → 清理 → 再挂载」：清理里 `cancelAnimationFrame` 了却**没把 ref 归零** →
 *   再挂载时闸门仍「已占用」→ **此后再也调度不出下一次更新**，显示永远停在挂载那一刻的
 *   正文；直到该轮结束 `streaming` 翻 false，才由 else 分支一次性 `setDisplay` 补全
 *   —— 用户看到的就是「文字停住不动，最后一次性补全」。
 *   （rAF 本身还会在主线程繁忙 / 页面隐藏时被饿死；定时器没有这个问题。）
 *
 * ⚠️ 为什么 **memo 挂 `content` 还不够**：本组件的 `content` 每帧都在变，
 *   所以**解析必须发生在 `MarkdownBody` 里**（它 memo 在节流后的 display 上）——
 *   `react-markdown@10` 每次 render 都 `createProcessor` + `parse` + `runSync` + `post`（零缓存）。
 *   桌面端同一个坑的修法见 `markdown-renderer.tsx`（DevTools trace：主线程 98% 占满）。
 *
 * ⚠️ **安全**：**不启用 `rehype-raw`** —— 原文里的 HTML 标签不会被解释执行，只是当文本显示
 * （`react-markdown` 默认行为）。链接强制新窗口 + `noopener`。
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitStablePrefix } from '../lib/stream-markdown'
import './Markdown.css'

/** 稳定的插件数组（避免每次渲染新建数组 → 让 ReactMarkdown 反复 work）。 */
const REMARK_PLUGINS = [remarkGfm]

/**
 * 流式显示节流间隔（毫秒）—— 显示层最多每这么久更新一次。
 *
 * 取值理由：100ms（10 次/秒）对人眼已足够「在长」，而把解析 / reconcile / 布局的频率
 * 比「每帧都来」降了一个数量级；同时它是**尾部可见延迟的确定上界**（终稿由 `streaming=false`
 * 分支立即对齐，不受本间隔影响）。
 */
export const STREAM_RENDER_MS = 100

/**
 * 尾沿节流：`streaming` 时把高频内容合并到最多每 `STREAM_RENDER_MS` 一次；
 * `streaming=false` 立即生效（保证终稿与不节流完全一致）。
 *
 * 用**定时器**而不是 `requestAnimationFrame`：rAF 不是「一定会到」的
 * （主线程繁忙 / 页面隐藏都会被饿死），而本 hook 的闸门一旦卡住就会**永久停更**——
 * 旧实现正是死在这一点上（卸载清理只取消 rAF、不把 ref 归零，StrictMode 的双调用
 * 把它变成僵尸句柄）。定时器语义简单可控：最坏延迟 = 本间隔。
 */
function useThrottledContent(content: string, streaming?: boolean): string {
  const [display, setDisplay] = useState(content)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 上一次真正写出 display 的时刻（用于算下一次的等待） */
  const lastAtRef = useRef(0)
  const latestRef = useRef(content)

  useEffect(() => {
    latestRef.current = content

    if (!streaming) {
      // 终稿：取消挂起的节流并立即对齐（保证最终结果与不节流完全一致）
      if (timerRef.current != null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setDisplay(content)
      return
    }

    // 已有一次待写 → 合并进它（尾沿节流：只保证「最后一次一定会写出」）
    if (timerRef.current != null) return

    const wait = STREAM_RENDER_MS - (Date.now() - lastAtRef.current)
    if (wait <= 0) {
      lastAtRef.current = Date.now()
      setDisplay(latestRef.current)
      return
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      lastAtRef.current = Date.now()
      setDisplay(latestRef.current)
    }, wait)
  }, [content, streaming])

  // 卸载清理：取消挂起的定时器，**并把 ref 归零** ——
  // ⚠️ 漏掉归零就会留下「已取消但非 null」的僵尸句柄，StrictMode 的「挂载→清理→再挂载」
  // 之后闸门永远占用，显示再也不会更新（历史真机缺陷根因，勿删）。
  useEffect(
    () => () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    },
    [],
  )

  return display
}

const COMPONENTS: Components = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // 表格可能很宽：套一层横向滚动，避免把整个消息区撑出横向滚动条
  table: ({ children }) => (
    <div className="md__table-wrap">
      <table>{children}</table>
    </div>
  ),
}

/**
 * MarkdownBody —— 纯渲染体，**全文件唯一的解析点**。
 *
 * props 只有一个字符串 → `memo` 按值命中：`content` 没变时 React 整棵跳过，
 * `react-markdown` 不会被调用（因而不解析）。这正是「省掉 O(n²) 解析」的全部机制。
 * ⚠️ 不要把 `<ReactMarkdown>` 挪回上面的 `Markdown` 组件体里 —— 那里每帧都会重渲染。
 */
const MarkdownBody = memo(function MarkdownBody({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
      {content}
    </ReactMarkdown>
  )
})

const Markdown = memo(function Markdown({
  content,
  streaming,
}: {
  content: string
  streaming?: boolean
}) {
  const display = useThrottledContent(content, streaming)

  // 切分按「显示内容」缓存：节流窗口内每帧都会重渲染，但 display 不变 → 不必重复扫描
  const [prefix, tail] = useMemo(() => splitStablePrefix(display), [display])

  // 流式隔离：已定稿前缀冻结，每帧只重建尾部那一小块（切分规则与桌面同源）
  if (streaming && prefix) {
    return (
      <div className="md">
        <MarkdownBody content={prefix} />
        <MarkdownBody content={tail} />
      </div>
    )
  }

  return (
    <div className="md">
      <MarkdownBody content={display} />
    </div>
  )
})

export default Markdown
