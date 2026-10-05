/**
 * 「在途 loading」的接线用例（两条规则一起钉）。
 *
 * 规则一：**点一下就要等返回值的按钮，在途时必须自证** —— 转圈 + 置灰，且不接受第二次提交。
 * 手机上没有 hover、也没有指针，一个纹丝不动的按钮与一个坏掉的按钮长得一模一样，
 * 而「点了没反应」正是用户唯一的判断依据。
 *
 * 规则二：**慢（>100ms）才显示** —— 网络好的时候先画出转圈再抹掉，比「什么都不显示、
 * 结果直接出现」更卡。但**拦截不能等**：`busy`（立刻为真）负责置灰与挡重复提交，
 * `pending`（慢才为真）才负责转圈与「…中」文案。两把尺子的实现见 `lib/pending.ts`，
 * 它自己的单测在 `pending.test.ts`；这里钉的是**接线**（每个按钮真的接了这两把尺子）。
 *
 * 手法：把真正那个 RPC 换成**受控的 Promise**，于是「在途」从一个转瞬即逝的瞬间
 * 变成可以断言的状态。
 */
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
  createMemoryPair,
  registerHostHandlers,
  type HostRegistration,
  type InteractionDTO,
  type MemoryTransport,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource } from 'virlen-remote/testing'
import Chat from '../ui/pages/Chat'
import Login from '../ui/pages/Login'
import InteractionCard from '../components/InteractionCard'
import LinkSheet from '../ui/components/LinkSheet'
import SessionInfoSheet from '../ui/components/SessionInfoSheet'
import { chatStore } from '../store/chat'
import { connectionStore } from '../store/connection'
import { devicesStore } from '../store/devices'
import { LOADING_DELAY_MS } from '../lib/pending'

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

/** 等**过**阈值：这一刻起，转圈与「…中」文案才该出现。 */
const waitSlow = (): Promise<void> =>
  act(async () => {
    await flush(LOADING_DELAY_MS + 30)
  })

/** 一个「由用例决定什么时候回」的 Promise —— 用来把「在途」定格住。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
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

/**
 * 接一台演示电脑。
 *
 * 能力集是 mock 如实声明的（含 `session.rename` / `pin` / `delete` / `compress`）——
 * 会话信息面板里的按钮全是**能力门控**的，不连上就一颗都不渲染，用例也就测不到 wiring。
 *
 * `messageCount` 给续页用例用：**必须多于一页**（50 条）才会出现「加载更早的消息」。
 *
 * `olderGate` 是**只卡住「更早的一页」**的闸门（首屏照常回来）：续页在途用例需要的是
 * 「`loadingOlder` 真的被置起、但 RPC 还没回来」这个状态 —— 卡在 mock 宿主那一侧才真实，
 * 直接 mock 掉 `chatStore.loadOlder` 反而会把要断言的那个标志一起 mock 掉。
 */
async function connect(
  options: { messageCount?: number; olderGate?: Promise<void> } = {},
): Promise<void> {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mock = createMockHostDataSource({
    ...(options.messageCount != null ? { demoMessageCount: options.messageCount } : {}),
    streamSteps: 1,
    streamDelayMs: 20,
  })
  if (options.olderGate) {
    const gate = options.olderGate
    const original = mock.getMessages.bind(mock)
    mock.getMessages = async (params) => {
      if (params.fromRowid != null) await gate
      return original(params)
    }
  }
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
}

function mount(node: ReactElement): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(node)
  })
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 按文案找按钮（与 `login-layout` / `device-rename-ui` 同一套查找方式）。 */
function button(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent?.trim() === label,
  )
  if (!found) throw new Error(`页面上没有「${label}」按钮`)
  return found
}

function query(label: string): HTMLButtonElement | null {
  return (
    [...(container?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent?.trim() === label,
    ) ?? null
  )
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

/** 发送按钮（`Chat` 输入区里那颗实心的）。 */
function sendButton(): HTMLButtonElement {
  const el = container!.querySelector<HTMLButtonElement>('.chat__input-row .btn--primary')
  if (!el) throw new Error('发送按钮没渲染出来')
  return el
}

function enter(el: Element): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
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
  vi.restoreAllMocks()
  connectionStore.disconnect()
  if (host) {
    host.reg.dispose()
    host.ep.dispose()
    host.hostT.close()
    host.mobileT.close()
    host = null
  }
})

describe('发送与停止（输入区）', () => {
  it('发送：快请求全程不闪；慢下来才转圈变「发送中」，且回车那条路径也发不出第二条', async () => {
    await connect()
    mount(createElement(Chat))

    const sending = deferred<void>()
    const send = vi.spyOn(chatStore, 'send').mockImplementation(() => sending.promise)

    typeInto(textarea(), '你好')
    const btn = sendButton()
    expect(btn.disabled).toBe(false)
    click(btn)

    // 请求发出去了一次；立刻只有「挡」生效（置灰），**还没有**转圈与文案变化
    expect(send).toHaveBeenCalledTimes(1)
    expect(btn.disabled).toBe(true)
    expect(btn.querySelector('.spinner')).toBeNull()
    expect(btn.textContent?.trim()).toBe('发送')

    /*
     * 回车不经过 `disabled`（`submit()` 由 onKeyDown 直接调）——「新对话」时 `send` 会先建会话，
     * 放过去就是并行建出两个空会话。这一道必须由页面自己挡（`run` 里那把同步闸刀）。
     */
    typeInto(textarea(), '第二条')
    enter(textarea())
    expect(send).toHaveBeenCalledTimes(1)

    // 超过阈值：这次真的慢了 → 转圈 + 「发送中」+ aria-busy
    await waitSlow()
    expect(btn.querySelector('.spinner')).not.toBeNull()
    expect(btn.textContent).toContain('发送中')
    expect(btn.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      sending.resolve()
      await flush()
    })

    // 回来即复原（输入框里还留着刚才那条没发出去的「第二条」）
    expect(btn.querySelector('.spinner')).toBeNull()
    expect(btn.textContent).toContain('发送')
    expect(btn.disabled).toBe(false)
  })

  it('停止：慢才说「停止中」（电脑侧还没推「已停」之前，按钮自己先兜住）', async () => {
    await connect()
    // 电脑侧推「正在回复」→ 输入区的发送按钮换成了「停止」
    act(() => {
      chatStore.applyEvent('host.event.session.runtime.changed', {
        sessionId: 'demo-1',
        runtime: { working: true },
      })
    })
    mount(createElement(Chat))

    const stopping = deferred<void>()
    const cancel = vi.spyOn(chatStore, 'cancel').mockImplementation(() => stopping.promise)

    const btn = button('停止')
    click(btn)

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(btn.disabled).toBe(true)
    expect(btn.textContent?.trim()).toBe('停止')

    await waitSlow()
    expect(btn.textContent?.trim()).toBe('停止中')
    expect(btn.querySelector('.spinner')).not.toBeNull()

    await act(async () => {
      stopping.resolve()
      await flush()
    })

    // `working` 还没翻（电脑侧的事件才管那个），所以按钮退回「停止」而不是「发送」
    expect(button('停止').querySelector('.spinner')).toBeNull()
  })
})

describe('待应答卡片（授权 / 提问）', () => {
  /** 一张普通的授权卡（非高风险，点了就直接发）。 */
  const AUTH: InteractionDTO = {
    interactionId: 'i-1',
    sessionId: 'demo-1',
    kind: 'authorization',
    createdAt: 0,
    tier: 'low',
    title: '执行命令',
    desc: 'npm run build',
    permName: 'terminal.normal.execute',
  }

  it('应答：三颗立刻置灰，转圈只长在被按下（且真的慢了）的那颗上', async () => {
    const answering = deferred<boolean>()
    const answer = vi.spyOn(chatStore, 'answer').mockImplementation(() => answering.promise)
    mount(createElement(InteractionCard, { interaction: AUTH }))

    const allow = button('允许')
    click(allow)

    expect(answer).toHaveBeenCalledTimes(1)
    // 立刻：三颗都点不动（重复应答只会换回一句「该请求已在电脑上处理」），但还没有转圈
    expect(allow.disabled).toBe(true)
    expect(button('拒绝').disabled).toBe(true)
    expect(button('暂存').disabled).toBe(true)
    expect(allow.querySelector('.spinner')).toBeNull()

    await waitSlow()
    expect(allow.querySelector('.spinner')).not.toBeNull()
    // 转圈只长在被按下的那颗上
    expect(button('拒绝').querySelector('.spinner')).toBeNull()

    await act(async () => {
      answering.resolve(false)
      await flush()
    })

    // 没被受理时卡片留着，按钮回到可点状态
    expect(button('允许').querySelector('.spinner')).toBeNull()
    expect(button('允许').disabled).toBe(false)
  })
})

describe('会话信息面板', () => {
  it('置顶：在途时（慢）该按钮转圈、其余动作一并置灰', async () => {
    await connect()
    act(() => {
      chatStore.applyEvent('host.event.session.list.changed', {
        sessions: [{ id: 'demo-1', title: '演示会话', updatedAt: 0, pinned: false }],
      })
    })
    mount(createElement(SessionInfoSheet, { sessionId: 'demo-1', onClose: () => {} }))

    const pinning = deferred<void>()
    const pin = vi.spyOn(chatStore, 'setPinned').mockImplementation(() => pinning.promise)

    const pinBtn = button('置顶')
    click(pinBtn)

    // 并发写操作会互相踩（最吓人的是「重命名 + 删除」同时在飞）：在途时只允许这一个
    expect(pin).toHaveBeenCalledTimes(1)
    expect(button('重命名').disabled).toBe(true)
    expect(button('删除').disabled).toBe(true)
    expect(pinBtn.querySelector('.spinner')).toBeNull()

    await waitSlow()
    expect(pinBtn.querySelector('.spinner')).not.toBeNull()

    await act(async () => {
      pinning.resolve()
      await flush()
    })

    expect(button('置顶').querySelector('.spinner')).toBeNull()
    expect(button('删除').disabled).toBe(false)
  })
})

describe('消息列表 · 续页（store 标志走同一把尺子）', () => {
  it('快不闪「加载中…」；慢才显示，且按钮立刻点不动', async () => {
    const gate = deferred<void>()
    await connect({ messageCount: 120, olderGate: gate.promise })
    mount(createElement(Chat))
    await act(async () => {
      await flush(30)
    })

    const older = (): HTMLButtonElement => {
      const el = container!.querySelector<HTMLButtonElement>('.chat__load-older')
      if (!el) throw new Error('续页按钮没渲染出来')
      return el
    }
    expect(older().textContent?.trim()).toBe('加载更早的消息')

    click(older())

    // 立刻：`loadingOlder` 已经为真（按钮点不动），但文案**不闪**
    expect(older().disabled).toBe(true)
    expect(older().textContent?.trim()).toBe('加载更早的消息')

    await waitSlow()
    expect(older().textContent?.trim()).toBe('加载中…')
    expect(older().querySelector('.spinner')).not.toBeNull()

    await act(async () => {
      gate.resolve()
      await flush(20)
    })
    /*
     * ⚠️ 轮询必须放在 `act` **外**：收回「加载中…」是 `useDelayedFlag` 里那次被动 effect
     * 触发的更新，而 act 作用域内不会把它 drain 掉（现象很迷惑人：`disabled` 已经变回去了，
     * 文案还停在「加载中…」）。真实浏览器里它就在下一帧。
     */
    await waitFor(() => older().textContent?.trim() === '加载更早的消息')
    expect(older().disabled).toBe(false)
  })
})

describe('登录页 · 连一台电脑', () => {
  it('正在连的那一台（慢才）转圈并变「连接中…」，不会糊到别的电脑上', async () => {
    devicesStore.upsert({ hostKey: 'dk-1', name: '书房主机', grant: 'gt-1', lastConnectedAt: 0 })
    devicesStore.upsert({ hostKey: 'dk-2', name: '客厅主机', grant: 'gt-2', lastConnectedAt: 0 })
    const connecting = deferred<boolean>()
    const connectSpy = vi
      .spyOn(connectionStore, 'connect')
      .mockImplementation(() => connecting.promise)
    mount(createElement(Login))

    // 设备行里的「连接」是唯一带 `btn--small` 的那颗（改名 / 删除是三级文字动作）
    const rows = [...container!.querySelectorAll<HTMLButtonElement>('.device .btn--small')]
    expect(rows.length).toBe(2)
    const [first, second] = rows
    expect(first.textContent?.trim()).toBe('连接')

    click(first)

    expect(connectSpy).toHaveBeenCalledTimes(1)
    // 立刻：一次只连一台（两颗都点不动），但文案还没变
    expect(first.disabled).toBe(true)
    expect(second.disabled).toBe(true)
    expect(first.textContent?.trim()).toBe('连接')

    await waitSlow()
    expect(first.textContent?.trim()).toBe('连接中…')
    expect(first.querySelector('.spinner')).not.toBeNull()
    // 用户点的是哪一台，就得是哪一台在转
    expect(second.textContent?.trim()).toBe('连接')

    await act(async () => {
      connecting.resolve(false)
      await flush()
    })

    expect(rows[0].textContent?.trim()).toBe('连接')
    expect(rows[0].disabled).toBe(false)
  })
})

describe('通讯状态面板', () => {
  it('立即重连：慢才变「重连中…」（不必等状态机翻到 connecting）', async () => {
    await connect()
    const reconnecting = deferred<void>()
    vi.spyOn(connectionStore, 'reconnectNow').mockImplementation(() => reconnecting.promise)
    mount(createElement(LinkSheet, { onClose: () => {} }))

    const btn = button('立即重连')
    expect(btn.disabled).toBe(false)
    click(btn)

    expect(btn.disabled).toBe(true)
    expect(btn.textContent?.trim()).toBe('立即重连')

    await waitSlow()
    expect(btn.textContent?.trim()).toBe('重连中…')
    expect(btn.querySelector('.spinner')).not.toBeNull()

    await act(async () => {
      reconnecting.resolve()
      await flush()
    })

    expect(query('重连中…')).toBeNull()
    expect(button('立即重连').disabled).toBe(false)
  })
})
