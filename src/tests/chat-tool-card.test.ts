/**
 * 工具调用卡片的接线冒烟用例（与 `chat-bubble-fold.test.ts` 同源的一次破例）。
 *
 * 为什么必须挂真实组件：「默认折叠 / 点一下展开」是组件内的 `useState`，纯函数测不到 ——
 * 它只能钉住「折叠态该显示什么文案」（`toolView`，见 `session-config-helpers.test.ts`）。
 * 而这次重做的核心恰恰是**形态**：折叠态只留「图标 + 工具名 + 规模」，正文与更全的规模
 * 展开后才进 DOM（不是靠 CSS 藏起来）。这些只有在 DOM 里可观测。
 *
 * 数据来源两条，都要覆盖：
 * - **真实链路**：memory transport + 共享包的 mock 宿主，`demoToolMessage` 给 `demo-1`
 *   追加一条带工具名的工具消息（就是真机上会渲染的那种）；
 * - **`chatStore.applyEvent`**：手机端解析不到工具名（`toolName` 缺失）、以及空输出这两种
 *   边界，mock 造不出来，只能自己投一条 —— 用的仍是消息入站那条公开入口。
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

/** mock 给的那条工具消息（`demoToolMessage`）：3 行清单，无结尾换行。 */
const MOCK_TOOL_TEXT = 'src/index.ts\nsrc/store.ts\nsrc/ui/pages/Chat.tsx'

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

function cards(): HTMLElement[] {
  return [...(container?.querySelectorAll<HTMLElement>('.msg--tool .tool-card') ?? [])]
}

/** 按工具名（或中性文案）找卡片 —— 用例里可能同时有好几张。 */
function cardOf(label: string): HTMLElement {
  const found = cards().find((c) => c.querySelector('.tool-card__head')?.textContent?.includes(label))
  if (!found) throw new Error(`没有找到「${label}」的工具调用卡片`)
  return found
}

function head(card: HTMLElement): HTMLButtonElement {
  const el = card.querySelector<HTMLButtonElement>('.tool-card__head')
  if (!el) throw new Error('工具卡片的头部没渲染出来')
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

describe('工具调用卡片', () => {
  it('默认只留「工具名 + 行数」；点一下出正文与更全的规模，再点收回', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    await waitFor(() => (chatStore.getSnapshot().messages['demo-1'] ?? []).length === 4)

    mount()
    await act(async () => {
      await flush(20)
    })

    const card = cardOf('list_files')
    // 折叠态：正文**不在 DOM 里**（不是 CSS 藏起来），规模也还没出现
    expect(card.querySelector('.tool-card__body')).toBeNull()
    expect(card.querySelector('.tool-card__meta')).toBeNull()
    expect(head(card).textContent).toContain('list_files')
    expect(head(card).querySelector('.tool-card__size')?.textContent).toBe('3 行')
    // 折叠态不该出现「工具」这种废话前缀：卡片的形态已经说明它是工具了
    expect(head(card).textContent).not.toContain('工具 ·')

    click(head(card))
    const body = cardOf('list_files').querySelector('.tool-card__body')
    expect(body).not.toBeNull()
    expect(body!.textContent).toBe(MOCK_TOOL_TEXT)
    // 展开后规模换成更全的一份（行数 + 字符数），且底部那行是它在撑着
    expect(cardOf('list_files').querySelector('.tool-card__meta')?.textContent).toBe('3 行 · 47 字符')
    expect(cardOf('list_files').querySelector('.tool-card__size')).toBeNull()

    click(head(cardOf('list_files')))
    expect(cardOf('list_files').querySelector('.tool-card__body')).toBeNull()
  })

  it('解析不到工具名：显示中性的「工具调用」，不猜也不装成代码', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    await waitFor(() => (chatStore.getSnapshot().messages['demo-1'] ?? []).length === 4)

    act(() => {
      chatStore.applyEvent('host.event.message.added', {
        sessionId: 'demo-1',
        message: { id: 'tool-unknown', role: 'tool', text: 'boom', createdAt: Date.now() },
      })
    })

    mount()
    await act(async () => {
      await flush(20)
    })

    const card = cardOf('工具调用')
    const name = card.querySelector('.tool-card__name')
    expect(name?.textContent).toBe('工具调用')
    // 中性文案不是标识符：不该有等宽 + 浅底的「代码」外观
    expect(name?.className).toContain('tool-card__name--unknown')
  })

  it('空输出：展开后明说「没有输出」，而不是留一张空白卡', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    await waitFor(() => (chatStore.getSnapshot().messages['demo-1'] ?? []).length === 4)

    act(() => {
      chatStore.applyEvent('host.event.message.added', {
        sessionId: 'demo-1',
        message: { id: 'tool-empty', role: 'tool', text: '   ', createdAt: Date.now(), toolName: 'noop' },
      })
    })

    mount()
    await act(async () => {
      await flush(20)
    })

    const card = cardOf('noop')
    // 折叠态不报规模：空白正文报「0 行」比自己承认没有输出更让人困惑
    expect(head(card).querySelector('.tool-card__size')).toBeNull()

    click(head(card))
    const expanded = cardOf('noop')
    expect(expanded.querySelector('.tool-card__body')).toBeNull()
    expect(expanded.querySelector('.tool-card__empty')?.textContent).toBe('这次调用没有输出')
    expect(expanded.querySelector('.tool-card__meta')).toBeNull()
  })
})
