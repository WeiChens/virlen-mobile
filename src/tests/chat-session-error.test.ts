/**
 * 会话错误横幅的接线冒烟用例（§21.4 的破例，与 `chat-bubble-fold.test.ts` 同源）：
 * **电脑侧会话出错时，手机上必须看得到原因**，并且点掉之后不会被同一句话反复弹回来。
 *
 * 背景（2026-10 真机反馈）：电脑端会话报错（API 401 / 工具报错 / 上下文超限），
 * 手机端只看到「工作中」变回空闲，错误原因一个字都没有 —— 只能跑回电脑前才知道发生了什么。
 *
 * 两半根因各有测试钉住：
 * - **存储**那一半在 `mobile-stores.test.ts`（`runtime.error` 落盘 / 缺席即清 / 已读按文本记）；
 * - **界面**这一半在这里：横幅到底有没有渲染、点一下能不能收掉 ——
 *   这两件事只在 DOM 里可观测（组件内订阅 + 本地已读状态）。
 *
 * 事件由测试直接经 `registerHostHandlers` 的 `emit` 推（mock 宿主没有「模拟会话出错」的入口），
 * 走的是**真实链路**：电脑侧 emit → 内存传输 → 手机端 `chatStore.applyEvent` → 组件。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION_ID = 'demo-1'

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
  const mock = createMockHostDataSource({ streamSteps: 2, streamDelayMs: 10 })
  const reg = registerHostHandlers(ep, mock, { deviceName: 'Virlen 电脑（演示）' })
  mock.bind(reg.emit)
  host = { hostT, mobileT, ep, reg, mock }
  await connectionStore.connect({
    hostId: 'demo-host',
    deviceName: '演示电脑',
    token: 'demo-token',
    transport: mobileT,
  })
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
 * 电脑侧推一帧运行时状态。
 *
 * 用 `act(async ...)` 包住 + 等到投递落地再退出：内存传输的投递是**异步**的，
 * 不等的话那次 store 更新会落在 act 外 → React 报「not wrapped in act」警告
 * （既有 UI 用例是 0 警告，不该由本文件引入噪音）。
 */
async function pushRuntime(runtime: { working: boolean; error?: string }): Promise<void> {
  if (!host) throw new Error('宿主还没起来')
  await act(async () => {
    host!.reg.emit('host.event.session.runtime.changed', { sessionId: SESSION_ID, runtime })
    await flush(20)
  })
}

/** 电脑侧推一帧「会话出了错」。 */
function pushError(error: string): Promise<void> {
  return pushRuntime({ working: false, error })
}

/** 当前横幅上的错误正文（没有横幅时为 null）。 */
function bannerText(): string | null {
  const el = container?.querySelector('.chat__banner--error .chat__banner-text')
  return el ? (el.textContent ?? '') : null
}

function dismissButton(): Element {
  const el = container?.querySelector('.chat__banner--error button')
  if (!el) throw new Error('错误横幅的「知道了」按钮没渲染出来')
  return el
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
})

describe('会话错误横幅 —— 电脑侧出错，手机上要说得出原因', () => {
  it('推来的错误 → 横幅出现；点「知道了」收掉；同一条不再弹，换一条立刻再出现', async () => {
    await connect()
    await chatStore.openSession(SESSION_ID)
    await waitFor(() => (chatStore.getSnapshot().messages[SESSION_ID] ?? []).length === 2)
    mount()

    // 修复前：这条错误被 store 丢掉，横幅永远不出现（用户对原因一无所知）
    await pushError('API Error (401)：凭证无效')
    await waitFor(() => bannerText() === 'API Error (401)：凭证无效')

    click(dismissButton())
    await waitFor(() => bannerText() === null)

    // 电脑侧重开这个会话会补推一帧**同样的**运行时快照（`storeBridge.pushRuntime`）：
    // 用户刚点掉，不该被同一句话再弹一次
    await pushError('API Error (401)：凭证无效')
    expect(bannerText()).toBeNull()

    // 换了内容（或电脑侧先清后报）→ 立刻重新出现
    await pushError('API Error (500)：服务端错误')
    await waitFor(() => bannerText() === 'API Error (500)：服务端错误')
  })

  it('电脑侧清掉错误（字段缺席）→ 手机上的横幅跟着消失', async () => {
    await connect()
    await chatStore.openSession(SESSION_ID)
    await waitFor(() => (chatStore.getSnapshot().messages[SESSION_ID] ?? []).length === 2)
    mount()

    await pushError('API Error (429)：请求过于频繁')
    await waitFor(() => bannerText() === 'API Error (429)：请求过于频繁')

    // 电脑侧重新发送时会先清掉上一条（`host-source.send`）→ 推一帧不带 error 的
    await pushRuntime({ working: true })
    await waitFor(() => bannerText() === null)
  })
})
