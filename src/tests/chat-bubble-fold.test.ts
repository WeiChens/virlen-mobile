/**
 * 折叠气泡的接线冒烟用例（§21.4 的破例，与 `chat-stream-render.test.ts` 同源）：
 * **压缩产生的上下文摘要默认折叠**，点头部才展开；再点收回。
 *
 * 为什么必须挂真实组件：折叠是组件内的 `useState`。纯函数层只能钉住「折叠态显示什么文案」
 * （`systemLabel`，见 `session-config-helpers.test.ts`），而「默认到底折没折」「点一下会不会
 * 展开」只有在 DOM 里可观测 —— 而这恰恰是本次真机反馈要求的行为（摘要动辄数屏，默认展开
 * 会把对话流冲散）。用例用 `react-dom/client` + `act` 直挂，不引入测试框架依赖。
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
  const mock = createMockHostDataSource({ streamSteps: 2, streamDelayMs: 15 })
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

/** 挂载真实的 `Chat` 页面（与生产同一套 `react-dom/client`）。 */
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

/** 必须重新查：React 会保留同一个 DOM 节点，但重新查能顺便钉住「头部没有被换掉」。 */
function foldHead(): HTMLElement {
  const el = container?.querySelector<HTMLElement>('.msg--system .msg__fold-head')
  if (!el) throw new Error('摘要气泡的折叠头没渲染出来')
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

describe('压缩摘要气泡：默认折叠（真机反馈：默认展开会把对话流冲散）', () => {
  it('默认只有折叠头（标签 + 开头）；点一下出全文，再点收回', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    await waitFor(() => (chatStore.getSnapshot().messages['demo-1'] ?? []).length === 2)

    // 走真实链路压缩：电脑侧把历史换成一条 `system` 摘要，手机端重拉窗口
    await chatStore.compressContext('demo-1')
    await flush(30)
    const summary = chatStore.getSnapshot().messages['demo-1'][0]
    expect(summary.role).toBe('system')

    mount()
    // 挂载 effect（`loadSessions`）与随后的 store 推送都在 `act` 内落定，否则会刷一堆 act 警告
    await act(async () => {
      await flush(20)
    })

    // 折叠态：**正文不在 DOM 里**（这就是「默认不展开」），但标签 + 正文开头仍在 ——
    // 「这里发生过一次上下文压缩」这条信息不能因为拥挤就丢掉
    const head = foldHead()
    expect(container!.querySelector('.msg__sys-body')).toBeNull()
    expect(head.textContent).toContain('上下文摘要')
    expect(head.textContent).toContain('之前的内容已压缩为摘要')

    click(head)
    const body = container!.querySelector('.msg__sys-body')
    expect(body).not.toBeNull()
    expect(body!.textContent).toBe(summary.text)

    // 收回：折叠是可逆的，点错了不用重开会话
    click(foldHead())
    expect(container!.querySelector('.msg__sys-body')).toBeNull()
  })
})
