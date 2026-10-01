/**
 * 消息区（`MessageList`）的接线用例 —— `@tanstack/react-virtual` 版（§34）。
 *
 * ## ⚠️ 先说清覆盖边界（这决定了本文件能钉什么、不能钉什么）
 *
 * 虚拟化由第三方库承担，而**库需要真实布局**：jsdom 里 `clientHeight` / `offsetHeight`
 * 全是 0（也没有 `ResizeObserver`）→ 库算出来的窗口是空的、一条都不渲染。
 *
 * 所以本文件钉的是**能自动验证的两件事**：
 * 1. **降级通道**：量不到布局时退回纯列表、消息一条不少（这也是既有组件级用例
 *    `chat-bubble-fold` / `chat-tool-card` 能继续跑的前提）；
 * 2. **结构契约**：哪些东西在虚拟化**之外**（消息行 / 尾部三块的位置），
 *    以及「滚动与重载都不会丢掉填到一半的状态」。
 *
 * 虚拟化本身的**锚定行为**（前插不跳位 / 贴底追加落底）由 `tanstack-anchor.test.ts`
 * 用可驱动的观察器桩在真库上验证；滚动的手感（惯性 / 渲染是否及时）仍只能真机核对。
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

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

const SESSION = 'demo-1'
/** 注入的历史条数（要明显多于「一屏能装下的量」，用来证明降级时并没有偷偷少渲染）。 */
const MANY = 150

function injectHistory(count: number): void {
  for (let i = 0; i < count; i += 1) {
    chatStore.applyEvent('host.event.message.added', {
      sessionId: SESSION,
      message: { id: `many-${i}`, role: 'user', text: `第 ${i} 条`, createdAt: Date.now() + i },
    })
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
  // demoToolMessage：让 mock 里带一条**工具调用**消息（折叠用例要用真实链路那条）
  const mock = createMockHostDataSource({ demoToolMessage: true, streamDelayMs: 15 })
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

const text = (): string => container?.textContent ?? ''
const msgCount = (): number => container?.querySelectorAll('.chat__messages .msg').length ?? 0

/** 找到工具卡片（按工具名，与 `chat-tool-card.test.ts` 同一套找法）。 */
function cardOf(label: string): HTMLElement {
  const found = [...(container?.querySelectorAll<HTMLElement>('.msg--tool .tool-card') ?? [])].find(
    (c) => c.querySelector('.tool-card__head')?.textContent?.includes(label),
  )
  if (!found) throw new Error(`没有找到「${label}」的工具调用卡片`)
  return found
}

beforeEach(async () => {
  chatStore.reset()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
  await connect()
  await chatStore.openSession(SESSION)
  await waitFor(() => (chatStore.getSnapshot().messages[SESSION] ?? []).length >= 4)
  injectHistory(MANY)
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

describe('消息区：降级通道与结构契约', () => {
  it('量不到布局时退回纯列表：**消息一条都不少**', async () => {
    mount()
    await act(async () => {
      await flush(30)
    })
    // 库在这种环境里一条都不渲染，降级通道必须把内容补上（否则是白屏）
    expect(container!.querySelector('.chat__messages--plain')).not.toBeNull()
    expect(msgCount()).toBeGreaterThanOrEqual(MANY)
    expect(text()).toContain('第 0 条')
    expect(text()).toContain(`第 ${MANY - 1} 条`)
  })

  it('结构契约：消息行在 `.vrow` 里；尾部（流式 / 卡片）在 `.chat__list-foot` 里 —— 不参与虚拟化', async () => {
    act(() => {
      chatStore.applyEvent('host.event.interaction.requested', {
        interaction: {
          interactionId: 'ask-1',
          sessionId: SESSION,
          kind: 'choice',
          createdAt: Date.now(),
          tier: 'low',
          question: '要选哪一个？',
          options: ['甲', '乙', '丙'],
        },
      })
    })
    mount()
    await act(async () => {
      await flush(30)
    })

    // 消息在行盒里（虚拟化会卸载/重建的就是这些行盒）
    expect(container!.querySelector('.vrow .msg')).not.toBeNull()
    // 卡片的家在尾部，**不在**行盒里 —— 它永远不会被窗口卸载
    expect(container!.querySelector('.chat__list-foot .icard')).not.toBeNull()
    expect(container!.querySelector('.vrow .icard')).toBeNull()
  })

  it('结构契约：头部（续页按钮）在**滚动容器之外** —— 它不参与虚拟化，也不会成为前插锚点的目标', async () => {
    mount()
    await act(async () => {
      await flush(30)
    })

    const scroller = container!.querySelector('.chat__messages')
    const head = container!.querySelector('.chat__list-head')
    expect(scroller).not.toBeNull()
    expect(head).not.toBeNull()
    /*
     * 头部必须**不在**滚动容器里：它与消息行同处一个坐标系时，用户停在顶部（`scrollTop`
     * 落在头部那段高度里）加载更早，库的锚点就变成头部 —— 它永远在 y=0 → 补偿量恒为 0 →
     * `scrollTop` 一个字节没变、屏幕上的内容却换了一屏（真机反馈的原话）。
     */
    expect(scroller!.contains(head!)).toBe(false)
    // 滚动容器里仍是「行 + 尾部」这一套（头部不再占一项）
    expect(scroller!.querySelector('.chat__list-foot')).not.toBeNull()
  })

  it('尾部状态不随消息重载丢失：填到一半的选择还在', async () => {
    act(() => {
      chatStore.applyEvent('host.event.interaction.requested', {
        interaction: {
          interactionId: 'ask-2',
          sessionId: SESSION,
          kind: 'choice',
          createdAt: Date.now(),
          tier: 'low',
          question: '要选哪一个？',
          options: ['甲', '乙'],
        },
      })
    })
    mount()
    await act(async () => {
      await flush(30)
    })

    const option = container!.querySelector<HTMLElement>('.chat__list-foot .icard__option')
    expect(option).not.toBeNull()
    click(option!)
    expect(container!.querySelector('.icard__option--on')).not.toBeNull()

    // 电脑侧整体替换消息（压缩 / 删消息）→ 本地窗口重拉 → 行全部重建
    await act(async () => {
      chatStore.applyEvent('host.event.session.messages.reset', { sessionId: SESSION })
      await flush(30)
    })
    await waitFor(() => (chatStore.getSnapshot().messages[SESSION] ?? []).length > 0)

    expect(container!.querySelector('.chat__list-foot .icard__option--on')).not.toBeNull()
  })

  it('折叠态挂在列表上（不在行组件里）：消息重载后仍是展开的', async () => {
    mount()
    await act(async () => {
      await flush(30)
    })

    const head = cardOf('list_files').querySelector<HTMLElement>('.tool-card__head')
    expect(head).not.toBeNull()
    click(head!)
    expect(cardOf('list_files').querySelector('.tool-card__body')).not.toBeNull()

    // 让行整批重建：折叠态若留在行组件里（`useState`），这里就会「又收起了」
    await act(async () => {
      chatStore.applyEvent('host.event.session.messages.reset', { sessionId: SESSION })
      await flush(30)
    })
    await waitFor(() => (chatStore.getSnapshot().messages[SESSION] ?? []).length > 0)

    expect(cardOf('list_files').querySelector('.tool-card__body')).not.toBeNull()
  })
})
