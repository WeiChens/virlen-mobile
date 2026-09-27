/**
 * 流式渲染回归（§29）：解析次数只与「**显示内容真正推进**」的次数一致，
 * 且**显示一定要推进**（不能卡住等终稿）。
 *
 * 真机缺陷：「文字停住不动，最后一次性补全」。电脑侧埋点已证明帧一路连续发
 * （`phone.push.stream` 31 条采样帧、`text_len` 单调 23 → 2234、`dropped: 0`），
 * 手机端接收链与 store 也无节流 —— 卡在渲染层，而且是**两层叠加的缺陷**：
 *
 *  A. **闸门被卡死（主因）**：`useThrottledContent` 用 rAF 做节流，闸门是「有没有一个 rAF
 *     在排队」（`if (rafRef.current == null)`），而卸载清理只 `cancelAnimationFrame`
 *     却**没把 ref 归零**。`main.tsx` 常驻 `<StrictMode>`，dev 下 React 会「挂载 → 清理 →
 *     再挂载」→ ref 变成「已取消但非 null」的僵尸句柄 → **此后再也调度不出下一次更新**，
 *     显示永远停在挂载那一刻的正文；直到该轮结束 `streaming` 翻 false，才由 else 分支
 *     一次性 `setDisplay` 补全 —— 正是用户看到的现象。
 *     （桌面端同名清理**有** `rafRef.current = null`，所以桌面不复现。）
 *
 *  B. **解析成本 O(n²)**：`<ReactMarkdown>` 原本直接写在 `Markdown` 组件体里，而该组件的
 *     `memo` 挂在 `content` 上、流式每帧 `content` 都在变 → 每帧无条件重新解析；
 *     `react-markdown@10` 的 `Markdown()` **零缓存**（每次 render 都 `createProcessor` +
 *     `parse` + `runSync` + `post`，已核对源码）。
 *
 * 修法：① 节流改**定时器驱动**并把 ref 归零（A）；② 解析点下沉到 `MarkdownBody`（`memo`
 * 在节流后的 display 上）+ 前缀冻结（B）。
 *
 * 本文件用「react-markdown 被调用了几次」＝「全文重新解析了几次」来钉住这两层，
 * 并**用一个 StrictMode 挂载用例单独钉住 A**（它才是「停住」的根因）。
 *
 * ⚠️ 这是手机端**第一个组件级渲染用例**（此前 UI 逻辑一律先落成纯函数，见 §21.4）。
 * 破例理由：缺陷的判别量（「一帧都没推进」/「一次都没解析」）在纯函数层不可观测 ——
 * 它恰恰就是「组件有没有重渲染」。用例用 `react-dom/client` + `act` 直挂，不引入测试框架依赖。
 */
import { StrictMode, act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** react-markdown 的调用记录 —— 每次调用就是一次「全量解析」。 */
const mdSpy = vi.hoisted(() => ({ parses: [] as string[] }))

// 把真实解析器换成「只记账」的桩：用例关心的是「解析了几次」，不是解析结果。
vi.mock('react-markdown', () => ({
  default: (props: { children?: unknown }) => {
    mdSpy.parses.push(String(props.children ?? ''))
    return null
  },
}))

import Markdown from '../components/Markdown'
import { Store, useStoreSelector } from '../lib/store'

// React 的 act 需要这个开关（React 19 起 act 从 react 包导出）
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 最后一条解析记录（手机端 tsconfig 目标是 ES2020，没有 `Array.prototype.at`）。 */
const lastParse = (): string | undefined => mdSpy.parses[mdSpy.parses.length - 1]

beforeEach(() => {
  mdSpy.parses.length = 0
  // 只伪造节流需要的那三样；**不要**连 queueMicrotask / MessageChannel 一起伪造（会打到 React 调度）
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  // rAF 已不再被 Markdown 使用；留个「只排队、不自动触发」的桩 ——
  // 万一有人把节流器改回 rAF，断言会以「显示不推进」失败，而不是抛 ReferenceError
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 推进节流窗口（跑掉挂起的定时器）。 */
function flushThrottle(ms = 300): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** 挂载一个真实 DOM 根（与生产同一套 `react-dom/client`）；`strict` 时套 `<StrictMode>`。 */
function mount(strict = false) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const tree = (content: string, streaming: boolean) =>
    strict
      ? createElement(StrictMode, null, createElement(Markdown, { content, streaming }))
      : createElement(Markdown, { content, streaming })
  return {
    render(content: string, streaming = true): void {
      act(() => {
        root.render(tree(content, streaming))
      })
    },
    unmount(): void {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** 造一个足够长的段落（超过 MIN_STABLE_PREFIX，才能触发前缀冻结） */
const LONG = 'A:' + '这是一段足够长的正文内容。'.repeat(26)
const TAIL1 = '正在写第一句'

describe('Markdown 流式渲染：只在「显示内容推进」时重新解析', () => {
  it('节流窗口内 content 变了但 display 未推进 → 一次都不解析（核心回归）', () => {
    const h = mount()
    h.render(`${LONG}\n\n${TAIL1}`)
    // 长文被切成 [前缀, 尾部]，各自解析一次
    expect(mdSpy.parses).toEqual([LONG, TAIL1])

    // 节流窗口内又推来一帧：组件会重渲染，但显示内容没变 → 不得解析
    h.render(`${LONG}\n\n${TAIL1}继续`)
    expect(mdSpy.parses).toEqual([LONG, TAIL1])

    // 节流到点 → 只重建尾部
    flushThrottle()
    expect(mdSpy.parses).toEqual([LONG, TAIL1, `${TAIL1}继续`])
    h.unmount()
  })

  it('前缀被冻住：尾部增长时前缀只解析一次', () => {
    const h = mount()
    h.render(`${LONG}\n\n${TAIL1}`)
    flushThrottle()
    h.render(`${LONG}\n\n${TAIL1}更长`)
    flushThrottle()
    expect(mdSpy.parses.filter((c) => c === LONG)).toHaveLength(1)
    expect(lastParse()).toBe(`${TAIL1}更长`)
    h.unmount()
  })

  it('消息定稿（streaming=false）时整篇一次性解析，不做拆分', () => {
    const h = mount()
    h.render(`${LONG}\n\n${TAIL1}`, false)
    flushThrottle()
    expect(lastParse()).toBe(`${LONG}\n\n${TAIL1}`)
    h.unmount()
  })

  it('StrictMode（挂载→清理→再挂载）之后，显示仍能继续推进（主因回归）', () => {
    const h = mount(true)
    h.render(`${LONG}\n\n${TAIL1}`)
    flushThrottle()

    const before = mdSpy.parses.length
    h.render(`${LONG}\n\n${TAIL1}更长`)
    flushThrottle()

    // 旧实现（rAF + 清理不归零）会在这里停在原地：闸门被僵尸句柄占死
    expect(mdSpy.parses.length).toBeGreaterThan(before)
    expect(lastParse()).toBe(`${TAIL1}更长`)
    h.unmount()
  })
})

/** 两切片 store：`b` 类比「流式正文」，`a` 类比「页面的其它状态」。 */
class SliceStore extends Store<{ a: number; b: number }> {
  setA(a: number): void {
    this.setState((s) => ({ ...s, a }))
  }
  setB(b: number): void {
    this.setState((s) => ({ ...s, b }))
  }
}

describe('useStoreSelector：切片没变就不重渲染', () => {
  it('改另一个切片不触发重渲染（这是「一个 token 不重渲染整页」的机制）', () => {
    const store = new SliceStore({ a: 0, b: 0 })
    let renders = 0
    function Consumer() {
      const a = useStoreSelector(store, (s) => s.a)
      renders += 1
      return createElement('span', null, String(a))
    }
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(createElement(Consumer))
    })
    const afterMount = renders

    act(() => {
      store.setB(1)
    })
    expect(renders).toBe(afterMount)

    act(() => {
      store.setA(2)
    })
    expect(renders).toBeGreaterThan(afterMount)

    act(() => {
      root.unmount()
    })
  })
})
