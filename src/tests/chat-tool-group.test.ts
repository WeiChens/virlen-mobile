/**
 * 工具调用组的接线冒烟用例（§35，与 `chat-tool-card.test.ts` 同源的一次破例）。
 *
 * 为什么必须挂真实组件：「组折叠着没有」「展开后组内每条**各自**还是折叠的」都是 DOM 里才
 * 可观测的行为 —— 纯函数层只能钉住「折叠态该显示什么文案」（`toolGroupView`，见
 * `message-rows.test.ts`）与「哪些消息合成一行」（`buildRows`）。
 *
 * ⚠️ V6 **不虚拟化**（DOM 节点数 = 消息数，jsdom 里同样全量渲染）→ 这里跑的就是真实通道。
 * 行模型的接线（`.vrow` 里是哪一种行）由 `ListRowView` 负责；滚动行为实现在 `inverted/stick.ts`
 * （正确性依据见参考项目 `react虚拟列表前向插入/docs/结论与选型.md`）。
 *
 * 数据来源两条，与 `chat-tool-card.test.ts` 一样：
 * - **真实链路**：memory transport + 共享包的 mock 宿主（演示会话里那条 `list_files`）；
 * - **`chatStore.applyEvent`**：连续多条工具调用（mock 一次只造得出一条），以及它们之间
 *   那条**空正文的 assistant**（引擎每轮都先落一条，真机上这就是常态）——
 *   用消息入站那条公开入口投进去，不碰内部状态。
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
  // demoToolMessage：演示会话里带一条工具调用（`list_files`，3 行输出）
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

/** 追加一条消息（走公开入站入口：`applyEvent` 的 `message.added`）。 */
function push(id: string, role: 'user' | 'assistant' | 'tool', patch: Record<string, unknown> = {}): void {
  act(() => {
    chatStore.applyEvent('host.event.message.added', {
      sessionId: SESSION,
      message: { id, role, text: '', createdAt: Date.now(), ...patch },
    })
  })
}

/** 组头（**必须重新查**：React 会保留同一个 DOM 节点，重查能顺便钉住「头部没被换掉」）。 */
function groupHead(): HTMLElement {
  const el = container?.querySelector<HTMLElement>('.tool-group__head')
  if (!el) throw new Error('工具组的组头没渲染出来')
  return el
}

/** 按工具名找卡片（组内组外同一套找法，与 `chat-tool-card.test.ts` 一致）。 */
function cardOf(label: string): HTMLElement {
  const found = [...(container?.querySelectorAll<HTMLElement>('.msg--tool .tool-card') ?? [])].find(
    (c) => c.querySelector('.tool-card__head')?.textContent?.includes(label),
  )
  if (!found) throw new Error(`没有找到「${label}」的工具调用卡片`)
  return found
}

function headOf(card: HTMLElement): HTMLButtonElement {
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

/** 演示会话就绪（4 条：user / assistant / tool / 空正文 assistant）。 */
async function ready(): Promise<void> {
  await connect()
  await chatStore.openSession(SESSION)
  await waitFor(() => (chatStore.getSnapshot().messages[SESSION] ?? []).length === 4)
}

describe('工具调用组：连续多条合成一行', () => {
  it('折叠成「3 次工具调用 · 共 5 行」；展开后是各自仍可再展开的卡片', async () => {
    await ready()

    /*
     * 追加两条工具调用（与演示会话那条 `list_files` 视觉连续），
     * 中间**故意夹一条空正文的 assistant**：真机上引擎每轮都先落一条，它不该打断合并。
     */
    push('tool-2', 'tool', { text: 'a\nb', toolName: 'grep' })
    push('gap', 'assistant', { text: '' })
    push('tool-3', 'tool', { text: '', toolName: 'read_file' })
    // 之后一条有正文的 assistant：它才是这一段的边界（看得见的东西截断合并）
    push('after', 'assistant', { text: '看完了。' })

    mount()
    await act(async () => {
      await flush(20)
    })

    // 一行就说明白了：调了几次 + 一共多大（后者是「要不要展开」的依据）
    expect(container!.querySelectorAll('.tool-group').length).toBe(1)
    expect(groupHead().textContent).toContain('3 次工具调用')
    expect(groupHead().textContent).toContain('共 5 行')

    // 折叠态：组内卡片**不在 DOM 里**（不是 CSS 藏起来）
    expect(container!.querySelector('.tool-group__body')).toBeNull()
    expect(container!.querySelector('.tool-card')).toBeNull()
    // 边界之外的正文照常渲染（组没有把后面那条消息吞进去）
    expect(container!.textContent).toContain('看完了。')

    click(groupHead())
    const inner = container!.querySelectorAll('.tool-group__body .tool-card')
    expect(inner.length).toBe(3)
    // 每条仍是「调了什么 + 有多大」：工具名与规模照旧（组只改「怎么排」，不改单条的信息）
    expect(
      [...inner].map((c) => c.querySelector('.tool-card__name')?.textContent),
    ).toEqual(['list_files', 'grep', 'read_file'])
    expect(
      [...inner].map((c) => c.querySelector('.tool-card__size')?.textContent),
    ).toEqual(['3 行', '2 行', undefined])
    // 组内每条**默认仍是折叠的**（一次铺开十条输出会把手机屏撑爆）
    expect(container!.querySelector('.tool-group__body .tool-card__body')).toBeNull()

    click(headOf(cardOf('grep')))
    expect(cardOf('grep').querySelector('.tool-card__body')?.textContent).toBe('a\nb')
    // 点一条不会顺带展开别的
    expect(container!.querySelectorAll('.tool-group__body .tool-card__body').length).toBe(1)

    // 组收回 → 再展开：组内那条的展开状态**还在**（折叠态记在列表上，不随行卸载丢）
    click(groupHead())
    expect(container!.querySelector('.tool-group__body')).toBeNull()
    click(groupHead())
    expect(cardOf('grep').querySelector('.tool-card__body')?.textContent).toBe('a\nb')
  })

  it('只有一条工具调用就不组（保持原来那张单卡）；空正文的消息不占行', async () => {
    await ready()
    mount()
    await act(async () => {
      await flush(20)
    })

    // 演示会话的顺序：user / assistant / tool / **空正文 assistant**
    // 行数 4 - 1（空正文不占行）= 3；工具只有一条 → 还是单卡，没有组头
    expect(container!.querySelectorAll('.vrow').length).toBe(3)
    expect(container!.querySelector('.tool-group')).toBeNull()
    expect(cardOf('list_files')).not.toBeNull()
  })
})
