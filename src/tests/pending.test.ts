/**
 * `lib/pending.ts` 的单测 —— 「慢才显示」这件事本身。
 *
 * 为什么值得单独钉：这条规则的价值全在**那 100ms 的窗口**里（快请求不该闪、慢请求必须显示），
 * 而窗口里的行为从 store 与页面 DOM 上都看不出来（store 压根不知道有 loading 这回事，
 * 页面只在慢的时候才有痕迹）。所以这里用一个小探针组件把两个钩子的状态渲染成 DOM 属性，
 * 再用受控 Promise 把「快」与「慢」两条路径各走一遍。
 */
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOADING_DELAY_MS, useDelayedFlag, usePending, type Pending } from '../lib/pending'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 等**过**阈值：这一刻起，「慢」才应该被显示出来。 */
const waitPastDelay = (): Promise<void> =>
  act(async () => {
    await flush(LOADING_DELAY_MS + 30)
  })

/** 一个「由用例决定什么时候回」的 Promise。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let container: HTMLDivElement | null = null
let root: Root | null = null
/** 探针交出来的钩子实例（用例直接调 `run`）。 */
let api: Pending<string> | null = null
/** 探针交出来的 `useDelayedFlag` 入参开关。 */
let setActive: ((value: boolean) => void) | null = null

/**
 * 探针：两个钩子都用一遍，把结果写成 DOM 属性（属性会真的重渲染才变 —— 这本身也是断言对象）。
 */
function Harness() {
  const pending = usePending<string>()
  api = pending
  const [active, set] = useState(false)
  setActive = set
  const slow = useDelayedFlag(active)
  return createElement('span', {
    id: 'state',
    'data-pending': pending.pending ?? '',
    'data-busy': String(pending.busy),
    'data-slow': String(slow),
  })
}

function state(): { pending: string; busy: boolean; slow: boolean } {
  const el = container!.querySelector('#state')!
  return {
    pending: el.getAttribute('data-pending') ?? '',
    busy: el.getAttribute('data-busy') === 'true',
    slow: el.getAttribute('data-slow') === 'true',
  }
}

beforeEach(() => {
  api = null
  setActive = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(Harness))
  })
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
  vi.restoreAllMocks()
})

describe('usePending —— 慢才转圈，但拦截立刻生效', () => {
  it('快（阈值内回来）：`pending` 一次都没为真，界面上什么都没闪', async () => {
    const task = deferred<void>()
    const done = vi.fn()

    let accepted = false
    act(() => {
      accepted = api!.run('k', () => task.promise, done)
    })
    expect(accepted).toBe(true)
    // 立刻：只有「在途」为真（置灰），还没有转圈
    expect(state()).toMatchObject({ pending: '', busy: true })

    await act(async () => {
      task.resolve()
      await flush(20) // 20ms ≪ 100ms：真实网络好的时候就是这样
    })

    expect(state()).toMatchObject({ pending: '', busy: false })
    expect(done).toHaveBeenCalledTimes(1)

    // 延时器已作废 —— 再等一整轮也不会突然冒出转圈（「闪一下」通常就是这个 bug）
    await waitPastDelay()
    expect(state().pending).toBe('')
  })

  it('慢（超过阈值还没回）：`pending` 才显示，回来即清掉', async () => {
    const task = deferred<void>()
    act(() => {
      api!.run('send', () => task.promise)
    })
    expect(state().pending).toBe('')

    await waitPastDelay()
    expect(state()).toMatchObject({ pending: 'send', busy: true })

    await act(async () => {
      task.resolve()
      await flush()
    })
    expect(state()).toMatchObject({ pending: '', busy: false })
  })

  it('在途时第二次点击被**当场**丢掉（返回 false），且不会顶掉第一次的 key', async () => {
    const task = deferred<void>()
    act(() => {
      api!.run('a', () => task.promise)
    })

    let accepted = true
    act(() => {
      accepted = api!.run('b', () => Promise.resolve())
    })
    expect(accepted).toBe(false)

    await waitPastDelay()
    expect(state().pending).toBe('a')

    await act(async () => {
      task.resolve()
      await flush()
    })
    // 闸刀放行后，下一个动作照跑（不是「锁死不放了」）
    let again = false
    act(() => {
      again = api!.run('b', () => Promise.resolve())
    })
    expect(again).toBe(true)
  })

  it('task 抛错不往外抛（`void` 掉的那个 Promise 一 reject 就是 unhandled rejection），收尾照做', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    let accepted = false
    act(() => {
      accepted = api!.run('k', () => Promise.reject(new Error('boom')))
    })
    expect(accepted).toBe(true)
    await act(async () => {
      await flush(10)
    })

    expect(state().busy).toBe(false)
    expect(errors).toHaveBeenCalled()
  })
})

describe('useDelayedFlag —— store 里已有的在途标志', () => {
  it('在阈值内落回：一次都不为真', async () => {
    act(() => setActive!(true))
    expect(state().slow).toBe(false)

    await act(async () => {
      await flush(20)
    })
    act(() => setActive!(false))

    await waitPastDelay()
    expect(state().slow).toBe(false)
  })

  it('超过阈值仍为 true：慢才为真；落回立刻收回', async () => {
    act(() => setActive!(true))
    await waitPastDelay()
    expect(state().slow).toBe(true)

    act(() => setActive!(false))
    expect(state().slow).toBe(false)
  })
})
