/**
 * 长按气泡菜单的**接线**用例（§36，§21.4 的破例，与 `chat-bubble-fold` 同源）。
 *
 * 纯函数层（`message-actions.test.ts`）只能钉住「菜单里该有什么」；这里钉的是
 * **它真的接上了**：手势 → 面板 → 三个动作各自到达该去的地方（剪贴板 / 输入框引用 / 电脑侧 RPC）。
 *
 * 其中两条是本功能最容易做错的：
 *  - **长按之后不能顺带触发那个按钮的 click**（工具卡的展开头就在长按目标里面）；
 *  - **删除必须真的打到电脑侧**（`host.session.message.delete`），且消息由
 *    `messages.reset` + 重拉窗口收尾 —— 本地先删一次会在真机上表现为「删了又回来」。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
  createMemoryPair,
  registerHostHandlers,
  type HostRegistration,
  type MemoryTransport,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource } from 'virlen-remote/testing'
import Chat from '../ui/pages/Chat'
import { chatStore } from '../store/chat'
import { connectionStore } from '../store/connection'
import { devicesStore } from '../store/devices'
import { LONG_PRESS_MS } from '../ui/components/use-long-press'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询直到条件成立（内存传输的事件投递是异步的）。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

interface HostHarness {
  hostT: MemoryTransport
  mobileT: MemoryTransport
  ep: Endpoint
  reg: HostRegistration
  mock: MockHostDataSource
}

let host: HostHarness | null = null
let container: HTMLDivElement | null = null
let root: Root | null = null

async function connect(): Promise<void> {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  // 带一条工具消息：验证「长按工具卡只给复制」且不会顺带把卡片展开
  const mock = createMockHostDataSource({ streamSteps: 1, streamDelayMs: 20, demoToolMessage: true })
  const reg = registerHostHandlers(ep, mock, { deviceName: 'Virlen 电脑（演示）' })
  mock.bind(reg.emit)
  host = { hostT, mobileT, ep, reg, mock }
  await connectionStore.connect({
    hostId: 'demo-host',
    deviceName: '演示电脑',
    token: 'demo-token',
    transport: mobileT,
  })
  await chatStore.openSession('demo-1')
  await waitFor(() => (chatStore.getSnapshot().messages['demo-1'] ?? []).length >= 4)
}

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(Chat))
  })
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/**
 * 派发一个触摸事件。
 *
 * jsdom 没有 `TouchEvent`，所以用普通 `Event` + 手工挂上 `touches`（React 的合成事件
 * 就是从原生事件的这两个字段上读坐标的）。
 */
function touch(el: Element, type: 'touchstart' | 'touchmove' | 'touchend', x = 0, y = 0): void {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(ev, {
    touches: type === 'touchend' ? [] : [{ clientX: x, clientY: y }],
    changedTouches: [{ clientX: x, clientY: y }],
  })
  act(() => {
    el.dispatchEvent(ev)
  })
}

/** 长按某条消息的气泡（`MessageRow` 把处理器挂在整行上，从气泡冒泡上去即可）。 */
async function longPress(target: Element): Promise<void> {
  touch(target, 'touchstart', 20, 20)
  await act(async () => {
    await flush(LONG_PRESS_MS + 80)
  })
  touch(target, 'touchend', 20, 20)
}

const panel = (): HTMLElement | null => container!.querySelector<HTMLElement>('.actpanel')
const actionBtn = (action: string): HTMLElement => {
  const el = container!.querySelector<HTMLElement>(`.actpanel__btn[data-action="${action}"]`)
  if (!el) throw new Error(`面板里没有 ${action} 项`)
  return el
}
/** 第 n 条用户气泡（`m1` 是演示会话里的第一条）。 */
const userBubble = (): Element => {
  const el = container!.querySelector('.msg--user .msg__bubble')
  if (!el) throw new Error('用户气泡没渲染出来')
  return el
}

/** 打字：React 受控组件必须走原型上的 setter，直接改 value 不会触发 onChange。 */
function typeInto(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(el, value)
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function textarea(): HTMLTextAreaElement {
  const el = container!.querySelector<HTMLTextAreaElement>('.chat__textarea')
  if (!el) throw new Error('输入框没渲染出来')
  return el
}

function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

beforeEach(() => {
  chatStore.reset()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
  connectionStore.disconnect()
  if (host) {
    host.reg.dispose()
    host.ep.dispose()
    host.hostT.close()
    host.mobileT.close()
    host = null
  }
  vi.restoreAllMocks()
})

describe('长按气泡 → 动作面板', () => {
  it('短按不弹面板；长按弹出三项（复制 / 引用 / 删除），且标题说明在操作哪条消息', async () => {
    await connect()
    mount()
    await act(async () => {
      await flush(20)
    })
    expect(panel()).toBeNull()

    // 只是按一下（不到长按时长）→ 不该弹
    touch(userBubble(), 'touchstart', 20, 20)
    expect(panel()).toBeNull()
    touch(userBubble(), 'touchend', 20, 20)
    await act(async () => {
      await flush(LONG_PRESS_MS + 40)
    })
    expect(panel()).toBeNull()

    await longPress(userBubble())
    expect(panel()).not.toBeNull()
    expect(panel()!.textContent).toContain('复制')
    expect(panel()!.textContent).toContain('引用')
    expect(panel()!.textContent).toContain('删除')
    // 标题：发送方 + 正文首行 —— 用户得知道自己在操作哪一条
    expect(container!.querySelector('.actpanel__who')!.textContent).toBe('你')
    expect(container!.querySelector('.actpanel__preview')!.textContent).toContain('你好')
  })

  it('滚动（位移超过阈值）不弹面板 —— 否则轻轻一滑就把菜单顶出来', async () => {
    await connect()
    mount()
    await act(async () => {
      await flush(20)
    })

    touch(userBubble(), 'touchstart', 20, 20)
    touch(userBubble(), 'touchmove', 20, 60)
    await act(async () => {
      await flush(LONG_PRESS_MS + 80)
    })
    touch(userBubble(), 'touchend', 20, 60)
    expect(panel()).toBeNull()
  })

  it('复制 → 写进剪贴板的是那条消息的正文，并给一次性提示', async () => {
    const writeText = stubClipboard()
    await connect()
    mount()
    await act(async () => {
      await flush(20)
    })

    await longPress(userBubble())
    click(actionBtn('copy'))
    await act(async () => {
      await flush(20)
    })

    expect(writeText).toHaveBeenCalledWith('你好，帮我看下今天的安排')
    expect(container!.querySelector('.chat__toast')?.textContent).toContain('已复制')
    // 复制完面板要收起
    expect(panel()).toBeNull()
  })
})

describe('引用（§36 结构化引用）', () => {
  it('引用 → 输入框上方出现 chip → 发送时把引文一并带上（且回来自带 `quotes`）', async () => {
    await connect()
    mount()
    await act(async () => {
      await flush(20)
    })

    await longPress(userBubble())
    click(actionBtn('quote'))
    await act(async () => {
      await flush(10)
    })

    // chip：看得见、带发送方
    const chip = container!.querySelector('.quote-chip')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toContain('你')
    expect(chip!.textContent).toContain('你好')

    typeInto(textarea(), '这条我要追问')
    const sendBtn = container!.querySelector<HTMLButtonElement>('.chat__input-row .btn--primary')!
    click(sendBtn)

    // 走真实链路：mock 把 quotes 落进用户消息，回来时结构化下行
    // ⚠️ 轮询包在 `act` 里：这期间电脑侧还在推流式事件（store 更新会触发 React 重渲染）——
    //    落在 `act` 外就是满屏的 act 警告，把真正有价值的输出淡化
    await act(async () => {
      await waitFor(() =>
        (chatStore.getSnapshot().messages['demo-1'] ?? []).some(
          (m) => m.role === 'user' && m.text === '这条我要追问' && (m.quotes?.length ?? 0) > 0,
        ),
      )
    })
    const sent = chatStore
      .getSnapshot()
      .messages['demo-1']
      .find((m) => m.role === 'user' && m.text === '这条我要追问')!
    expect(sent.quotes?.[0]).toMatchObject({ role: 'user', text: '你好，帮我看下今天的安排' })

    // chip 发出去后要清掉（否则下一条消息会莫名其妙再引用一次）
    expect(container!.querySelector('.quote-chip')).toBeNull()

    // 引用条渲染在该气泡里（结构化引用只出现一次：`text` 里不再有 `[引用] …`）
    await act(async () => {
      await flush(20)
    })
    const bar = container!.querySelector('.quote-bar')
    expect(bar).not.toBeNull()
    expect(bar!.textContent).toContain('你好，帮我看下今天的安排')
    expect(sent.text).not.toContain('[引用]')
  })

  it('chip 上的 × 能撤回（发出去之前反悔的成本必须足够低）', async () => {
    await connect()
    mount()
    await act(async () => {
      await flush(20)
    })

    await longPress(userBubble())
    click(actionBtn('quote'))
    expect(container!.querySelector('.quote-chip')).not.toBeNull()

    click(container!.querySelector('.quote-chip__remove')!)
    expect(container!.querySelector('.quote-chip')).toBeNull()
  })
})

describe('工具卡：长按只给复制，且不打断展开', () => {
  it('长按工具卡 → 面板只有「复制」（工具消息不可删、也不给引用）', async () => {
    await connect()
    mount()
    await act(async () => {
      await flush(20)
    })

    const card = container!.querySelector('.tool-card')!
    await longPress(card)
    const actions = [...container!.querySelectorAll('.actpanel__btn')].map((el) =>
      (el as HTMLElement).dataset.action,
    )
    expect(actions).toEqual(['copy'])
  })

  it('长按**不会**顺手把折叠卡片展开（长按后那次 click 必须被吃掉）', async () => {
    await connect()
    mount()
    await act(async () => {
      await flush(20)
    })

    const card = container!.querySelector('.tool-card')!
    await longPress(card)
    // 抬手（浏览器会补一个 click）—— 这个 click 不能被卡片头当成「展开」
    touch(card.querySelector('.tool-card__head')!, 'touchend')
    click(card.querySelector('.tool-card__head')!)
    expect(container!.querySelector('.tool-card__body')).toBeNull()
    expect(container!.querySelector('.tool-card')!.classList.contains('is-open')).toBe(false)

    // 而正常的点击照旧能展开（抑制窗不能长期生效 —— 否则卡片就点不开了）
    await act(async () => {
      await flush(800)
    })
    click(container!.querySelector('.tool-card__head')!)
    expect(container!.querySelector('.tool-card')!.classList.contains('is-open')).toBe(true)
  })
})

describe('删除（截断，不可逆）', () => {
  it('二次确认（文案报明条数）→ 打到电脑侧 RPC → 消息由重拉窗口收尾', async () => {
    await connect()
    mount()
    await act(async () => {
      await flush(20)
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    await longPress(userBubble())
    click(actionBtn('delete'))
    await act(async () => {
      await flush(30)
    })

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    // 确认文案必须能被核对：删的是「这条 + 它之后的那几条」
    const asked = confirmSpy.mock.calls[0][0] as string
    expect(asked).toContain('删除这条消息')
    expect(asked).toContain('不可恢复')

    expect(host!.mock.calls).toContain('host.session.message.delete')
    // 电脑侧从 m1 起截断 → 手机端重拉窗口后一条不剩
    await act(async () => {
      await waitFor(() => (chatStore.getSnapshot().messages['demo-1'] ?? []).length === 0)
    })
  })

  it('用户在确认框里点「取消」→ 一个请求都不发', async () => {
    await connect()
    mount()
    await act(async () => {
      await flush(20)
    })
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    await longPress(userBubble())
    click(actionBtn('delete'))
    await act(async () => {
      await flush(30)
    })

    expect(host!.mock.calls).not.toContain('host.session.message.delete')
    expect((chatStore.getSnapshot().messages['demo-1'] ?? []).length).toBeGreaterThan(0)
  })
})
