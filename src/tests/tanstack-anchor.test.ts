// @vitest-environment jsdom
/**
 * `@tanstack/react-virtual` 的**锚定行为契约**（§34 迁移）—— 本仓少数几处「测库」的文件之一。
 *
 * 为什么值得留：`MessageList` 的两条核心行为全靠库的两个选项承担 ——
 * `anchorTo: 'end'`（前插不跳位）与 `followOnAppend`（只贴底时才跟着落底）。
 * 这是**没有文档保证**（但源码可读、已逐段核对过 virtual-core 3.17.11）的依赖，
 * 一旦升级换了行为，真机上就会重演那两轮「跳最上面 / 跳最下面」的缺陷。用例把它钉住。
 *
 * ## 怎么在 jsdom 里驱动真库
 *
 * 库要「布局 + 观察器 + 滚动」，jsdom 三样都没有 —— 但三样都能**从外面换掉**（都是选项，
 * 框架适配器只是提供了默认实现）：
 * - `observeElementRect` / `observeElementOffset` / `scrollToFn` → 换成测试可控的桩
 *   （自己发视口尺寸、自己发滚动偏移、自己记录写入值）；
 * - `measureElement` → 按元素上的 `data-size` 返回高度（真实环境里是量 DOM）。
 * 于是「挂载 → 滚动 → 前插/追加」整条链是**真的库在跑**，只是输入换成了确定性的。
 *
 * 覆盖的行为：
 * 1. **前插不跳位**：捕「视口顶那一项」，在新布局里按 key 找回来，把 `scrollTop` 加上
 *    新插入内容的高度 —— 视口里看到的那一条不动；
 * 2. **前插的项还没测量（只有估算）时同样成立**：补偿按估算走、锚点项仍在原处
 *    （估算与真实值的差额由库在「项被测量到」时另行补，见用例里的说明）；
 * 3. **停在列表最顶（视口顶 = 第 0 项）时同样成立** —— 这条是用户实际的操作位置
 *    （上拉续页的触发点就在顶部），也是「头部必须留在滚动容器之外」的原因所在：
 *    头部若占第 0 项，它永远在 y=0 → 锚点落在它身上 → 补偿量恒为 0；
 * 4. **重复 key 会把锚点解析到错误的那一条上** —— 这条用例把「窗口必须按 id 去重」
 *    钉死（真机缺陷：控制台报 `Encountered two children with the same key`，
 *    而用户看到的正是「视图被甩走」）；
 * 5. **贴底追加才落底**：`followOnAppend` 在贴底时把 `scrollTop` 带到新底部；
 *    **不贴底时一个字节都不写**（不打扰翻历史）。
 */
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VIEWPORT = 600

/** 测试侧的「控制器」：假观察器与本子上记的滚动写入都挂在这里。 */
interface Ctrl {
  rect?: (rect: { width: number; height: number }) => void
  offset?: (offset: number, isScrolling: boolean) => void
  /** 每次 `scrollToFn` 的**目标值**（含 adjustments）—— 库里「想滚到哪」的原始意图。 */
  writes: number[]
  /** 浏览器语义：写进去以后被夹到 `[0, scrollHeight - clientHeight]` 的实际值。 */
  applied: number
  /** 当前 DOM 的内容总高（模拟 `scrollHeight`）—— 随每次**提交**更新，不是渲染期。 */
  total: number
  /** 拿到虚拟器实例，便于断言「锚点项在哪」。 */
  instance?: Virtualizer<HTMLDivElement, Element>
}

function makeCtrl(): Ctrl {
  return { writes: [], applied: 0, total: 0 }
}

/**
 * 探针：真库 + 假观察器。
 *
 * 容器元素上就地定义 `clientHeight` / `scrollHeight`（jsdom 里恒为 0），供库
 * 算「最大滚动位置」与「在不在底部」。`scrollToFn` 按浏览器语义把目标值夹进区间并记录。
 */
function Probe({ items, ctrl, estimate = 100 }: { items: string[]; ctrl: Ctrl; estimate?: number }) {
  const elRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => elRef.current,
    estimateSize: () => estimate,
    getItemKey: (i) => items[i],
    overscan: 0,
    anchorTo: 'end',
    followOnAppend: true,
    // 与生产同口径，但取 1：用例要验证的是「贴底/不贴底」这条闸门本身
    scrollEndThreshold: 1,
    observeElementRect: (_instance, cb) => {
      ctrl.rect = cb
      cb({ width: 400, height: VIEWPORT })
    },
    observeElementOffset: (_instance, cb) => {
      ctrl.offset = cb
    },
    scrollToFn: (offset, { adjustments }, instance) => {
      const target = offset + (adjustments ?? 0)
      ctrl.writes.push(target)
      const max = Math.max(0, ctrl.total - VIEWPORT)
      ctrl.applied = Math.min(Math.max(target, 0), max)
      if (instance.scrollElement) {
        ;(instance.scrollElement as HTMLElement).scrollTop = ctrl.applied
      }
    },
    measureElement: (node) => Number(node.getAttribute('data-size') ?? estimate),
  })

  ctrl.instance = virtualizer as Virtualizer<HTMLDivElement, Element>

  return createElement(
    'div',
    {
      ref: (node: HTMLDivElement | null) => {
        elRef.current = node
        if (!node) return
        Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => VIEWPORT })
        Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => ctrl.total })
        Object.defineProperty(node, 'scrollTop', { configurable: true, writable: true, value: 0 })
        /*
         * 模拟「提交之后 DOM 的高度」：`scrollHeight` 在**渲染期**读到的应该是**上一次提交**
         * 的值（浏览器就是这样）—— 而 ref 回调发生在提交里、layout effect 之前。
         */
        ctrl.total = items.length * 100
      },
    },
    createElement(
      'div',
      { style: { height: virtualizer.getTotalSize() } },
      virtualizer.getVirtualItems().map((vi) =>
        createElement(
          'div',
          {
            key: String(vi.key),
            'data-index': vi.index,
            'data-size': 100,
            ref: virtualizer.measureElement,
          },
          items[vi.index],
        ),
      ),
    ),
  )
}

const BASE = Array.from({ length: 20 }, (_, i) => `base-${i}`)
const OLDER = Array.from({ length: 5 }, (_, i) => `older-${i}`)

let container: HTMLDivElement | null = null
let root: Root | null = null
let ctrl: Ctrl = makeCtrl()

function mount(items: string[], estimate = 100): void {
  ctrl = makeCtrl()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(Probe, { items, ctrl, estimate }))
  })
}

/** 换一份数据（同一棵树、同一个滚动容器 —— 这就是「前插 / 追加」那一步）。 */
function rerender(items: string[], estimate = 100): void {
  act(() => {
    root!.render(createElement(Probe, { items, ctrl, estimate }))
  })
}

/** 模拟用户滚动：直接给库发一次偏移回调（真实浏览器里由 scroll 事件驱动）。 */
function scrollTo(offset: number): void {
  act(() => {
    ctrl.offset?.(offset, false)
  })
}

/** 当前在 `offset` 这个位置上的那一项（视口顶那一项就是它）。 */
function itemAt(offset: number): string | undefined {
  return ctrl.instance?.getVirtualItemForOffset(offset)?.key as string | undefined
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
  ctrl = makeCtrl()
})

describe('anchorTo: "end"：边缘变化时按 key 锚住视口', () => {
  it('前插不跳位：`scrollTop` 加上新插入内容的高度，视口里那一条不动', () => {
    mount(BASE)
    scrollTo(300) // 用户滚到 300：视口顶 = base-3（它从 300 开始）
    ctrl.writes.length = 0 // 忽略挂载阶段的初始写入

    rerender([...OLDER, ...BASE]) // 上拉续页：前插 5 条（各 100px）

    // 5 × 100 = 500 → 目标 800；而且**只写这一笔**（没有别的补偿混进来）
    expect(ctrl.writes).toEqual([800])
    expect(ctrl.applied).toBe(800)
    // 视口顶还是 base-3 —— 用户看到的内容没动（它现在从 800 开始）
    expect(itemAt(800)).toBe('base-3')
  })

  it('前插的项还没测量（只有估算）时同样不跳位：补偿按估算走，锚点项仍在原处', () => {
    // 估算 40 / 真实 100：前插进来的那一页大多在窗口外，一时半会量不到 —— 真机上的常态
    mount(BASE, 40)
    scrollTo(300)
    ctrl.writes.length = 0

    rerender([...OLDER, ...BASE], 40)

    // 补偿 = 5 × 估算 40 = 200 → 目标 500（估算与真实值的差额等它们被渲染/测量到时，
    // 由库按「项顶在视口上方 → 补差额」另行纠正 —— 那一步不在本用例的输入范围内）
    expect(ctrl.writes).toEqual([500])
    expect(itemAt(500)).toBe('base-3')
  })

  it('停在列表最顶（视口顶 = 第 0 项）时前插：第 0 项钉在原地，新的历史安静地出现在它上方', () => {
    mount(BASE)
    scrollTo(0) // 用户上拉到最顶 —— 自动续页的触发点就在这附近
    ctrl.writes.length = 0

    rerender([...OLDER, ...BASE])

    // 补偿 = 5 × 100 = 500：视口顶仍钉在 base-0 上（它现在从 500 开始）
    expect(ctrl.writes).toEqual([500])
    expect(ctrl.applied).toBe(500)
    expect(itemAt(500)).toBe('base-0')
  })

  it('⚠️ 重复 key 会把锚点解析到**错误的那一条**上 —— 这就是窗口必须按 id 去重的原因', () => {
    mount(BASE)
    scrollTo(300) // 视口顶 = base-3（它从 300 开始）
    ctrl.writes.length = 0

    // 坏数据：同一份 base-3 在列表**最前面**又出现了一次（电脑侧窗口重叠的等价物）。
    // 库的锚点查找是「从 0 开始找**第一个** key 相同的项」，于是找到的是开头那一份（start=0）。
    rerender(['base-3', ...OLDER, ...BASE])

    // 补偿把 offset 提到了 0（而正确值应该是「base-3 在新布局里的位量」= 900）→
    // 用户被从「正在读第 300px 处」一把甩到列表最顶。
    // 这条用例不断言「正确补偿」，而是钉住**错误的后果**：去重不是优化，是正确性前提。
    expect(ctrl.applied).toBeLessThan(300)
    expect(itemAt(0)).toBe('base-3')
  })
})

describe('followOnAppend：只贴底时才跟着落底', () => {
  it('贴底时追加 → 落到**新**底部', () => {
    mount(BASE) // 20 × 100 = 2000，视口 600 → 最大滚动位置 1400
    scrollTo(1400) // 贴底
    ctrl.writes.length = 0

    rerender([...BASE, 'new-1']) // 21 × 100 - 600 = 1500
    expect(ctrl.writes[ctrl.writes.length - 1]).toBe(1500)
    expect(ctrl.applied).toBe(1500)
  })

  it('不贴底时追加 → **一个字节都不写**（正在翻历史的用户不该被拽走）', () => {
    mount(BASE)
    scrollTo(300) // 视口中段（离底 1100px）
    ctrl.writes.length = 0

    rerender([...BASE, 'new-1', 'new-2'])
    expect(ctrl.writes).toEqual([])
    expect(itemAt(300)).toBe('base-3')
  })
})
