/**
 * 消息区（`MessageList`）的接线用例 —— V6 倒置列表版（§34）。
 *
 * ## ⚠️ 先说清覆盖边界
 *
 * V6 **完全不虚拟化**：DOM 节点数 = 消息数，所有行在任何环境下都会被渲染（jsdom 也不例外）
 * 且**始终参与真实布局**。所以这里能钉的比旧版更多：
 * 1. **不丢消息**：注入多少条就渲染多少条（首尾都在）；
 * 2. **结构契约**：哪些东西在行序列**之外**（消息行 / 尾部三块的位置），
 *    以及「滚动与重载都不会丢掉填到一半的状态」。
 *
 * 滚动行为（前插不跳位 / 贴底跟随 / 翻历史不被打断）实现在 `inverted/stick.ts`，其正确性依据
 * 与实测见参考项目 `react虚拟列表前向插入/docs/结论与选型.md`；滚动的手感仍只能真机核对。
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
/** 注入的历史条数（要明显多于「一屏能装下的量」，用来证明「不虚拟化」时一条都没漏渲染）。 */
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

describe('消息区：不虚拟化与结构契约', () => {
  it('不虚拟化：消息**一条都不少**（DOM 节点数 = 消息数，首尾都在）', async () => {
    mount()
    await act(async () => {
      await flush(30)
    })
    // V6 不用布局测量，任何环境都全量渲染（否则就是白屏 / 丢消息）
    expect(container!.querySelector('.chat__messages')).not.toBeNull()
    expect(msgCount()).toBeGreaterThanOrEqual(MANY)
    expect(text()).toContain('第 0 条')
    expect(text()).toContain(`第 ${MANY - 1} 条`)
  })

  it('结构契约：消息行在 `.vrow` 里；尾部（流式 / 卡片）在 `.chat__list-foot` 里 —— 独立于行序列', async () => {
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

    // 消息在行盒里
    expect(container!.querySelector('.vrow .msg')).not.toBeNull()
    // 卡片的家在尾部，**不在**行盒里 —— 它不受行序列的镜像/排序影响
    expect(container!.querySelector('.chat__list-foot .icard')).not.toBeNull()
    expect(container!.querySelector('.vrow .icard')).toBeNull()
  })

  it('结构契约：续页按钮在滚动内容里、位于**视觉顶部**（倒置容器末位）', async () => {
    mount()
    await act(async () => {
      await flush(30)
    })

    const scroller = container!.querySelector('.chat__messages')
    expect(scroller).not.toBeNull()
    // 顶部块（续页按钮 / 「加载消息…」提示）在滚动容器**内**
    const top = scroller!.querySelector('.chat__list-top')
    expect(top).not.toBeNull()
    // 尾部（流式气泡 / 卡片）也在滚动容器内
    expect(scroller!.querySelector('.chat__list-foot')).not.toBeNull()
    /*
     * 视觉顺序：倒置容器里「DOM 末位 = 视觉最顶部」，所以顶部块必须是**最后一个**元素子节点
     * —— 这样它才出现在最早那条消息之上、并随内容一起滚动（`scaleY(-1)` 会把它镜像回来）。
     */
    expect(scroller!.lastElementChild).toBe(top)
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
