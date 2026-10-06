/**
 * 压缩方式（§22）—— 手机端的两个入口 + 「选了哪种就真的走哪种」。
 *
 * 为什么值得一组 DOM 用例：这条功能的失败形态**全是静默的** ——
 *  - 两个按钮都在，但 `mode` 没被带上 → 用户以为点了「正文压缩」，实际走的是 AI 摘要（**还花了钱**）；
 *  - 旧电脑端（不认 `mode`）上仍显示选择器 → 同上，而且没有任何报错可查；
 *  - 二次确认被绕过 → 不可逆操作直接执行（与「删除会话」同档）。
 * 三件事都只能从「点下去之后电脑侧收到了什么」看出来，纯函数层看不到。
 *
 * 链路是真的：内存传输 + 演示宿主（`virlen-remote/testing`），它按 `mode` 出**不同产物**，
 * 并用 `lastCompress()` 当宿主侧观察口。断言落在宿主侧，而不是本端的乐观状态上 ——
 * 否则「手机显示了已压缩」这种事会自己给自己发绿灯。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMPRESS_MODE_CAPABILITY,
  Endpoint,
  createMemoryPair,
  registerHostHandlers,
  type CompressParams,
  type HelloParams,
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

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
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
  /** 电脑侧**实际收到**的压缩请求（用它证明 `mode` 到底带没带）。 */
  seen: CompressParams[]
  /** 本端在 `hello` 里声明的能力名（协商的输入）。 */
  clientCaps: string[]
}

let host: HostHarness | null = null
let container: HTMLDivElement | null = null
let root: Root | null = null

/**
 * 连上一台假电脑。
 *
 * @param hostCapabilities 该电脑端在 `hello` 应答里声明的能力集；**不传** = 用演示宿主的原样
 *   （它声明了 `session.compress.mode`）。传一个不含它的集合即模拟「旧电脑端」。
 */
async function connect(hostCapabilities?: string[]): Promise<void> {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 3000 })
  const mock = createMockHostDataSource()
  const seen: CompressParams[] = []
  const clientCaps: string[] = []
  const originalCompress = mock.compress.bind(mock)
  const source: MockHostDataSource = {
    ...mock,
    hello: async (params: HelloParams) => {
      clientCaps.push(...(params.capabilities ?? []))
      const result = await mock.hello!(params)
      return hostCapabilities ? { ...result, capabilities: hostCapabilities } : result
    },
    compress: async (params: CompressParams) => {
      seen.push(params)
      return originalCompress(params)
    },
  }
  const reg = registerHostHandlers(ep, source, { deviceName: 'Virlen 电脑（演示）' })
  mock.bind(reg.emit)
  host = { hostT, mobileT, ep, reg, mock, seen, clientCaps }
  await connectionStore.connect({
    hostId: 'demo-host',
    deviceName: '演示电脑',
    token: 'demo-token',
    transport: mobileT,
  })
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 按可见文案找按钮（面板里的按钮文案就是用户看到的那几个字）。 */
function button(text: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent?.trim() === text,
  )
  if (!found) throw new Error(`面板上没有「${text}」按钮`)
  return found as HTMLButtonElement
}

function hasButton(text: string): boolean {
  return [...(container?.querySelectorAll('button') ?? [])].some(
    (b) => b.textContent?.trim() === text,
  )
}

/** 挂 `Chat` → 打开会话 → 点标题区开「会话信息」面板（与用户的手势同一条路）。 */
async function openInfoSheet(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(Chat))
  })
  await chatStore.loadSessions()
  await chatStore.openSession(SESSION_ID)
  await waitFor(() => chatStore.getSnapshot().currentSessionId === SESSION_ID)
  // 占用快照到位才有「压缩」按钮（判据是共享包的 `COMPRESS_MIN_RATIO`）
  await waitFor(() => chatStore.getSnapshot().context[SESSION_ID] != null)
  await act(async () => {
    await flush(20)
  })
  click(container.querySelector('.chat__head-main')!)
  await waitFor(() => container!.textContent!.includes('会话信息'))
}

beforeEach(() => {
  chatStore.reset()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
})

afterEach(async () => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
  connectionStore.disconnect()
  host?.reg.dispose()
  host?.ep.dispose()
  host?.hostT.close()
  host?.mobileT.close()
  host = null
  vi.unstubAllGlobals()
  await flush(0)
})

describe('压缩方式：两个入口（电脑端声明了 session.compress.mode）', () => {
  it('两个按钮都在；点「正文压缩」→ 电脑侧**真的**走 raw，产物也如实换了', async () => {
    const confirmSpy = vi.fn((_message?: string) => true)
    vi.stubGlobal('confirm', confirmSpy)
    await connect()
    await openInfoSheet()

    expect(hasButton('AI 摘要压缩')).toBe(true)
    expect(hasButton('正文压缩')).toBe(true)
    // 能选方式时不再有那个笼统的旧按钮（两个入口取代它，不是并存）
    expect(hasButton('压缩上下文')).toBe(false)

    click(button('正文压缩'))
    // 不可逆操作先二次确认，且文案点明是哪种方式
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(String(confirmSpy.mock.calls[0]![0])).toContain('正文压缩')

    await waitFor(() => host!.seen.length > 0)
    await waitFor(() => chatStore.getSnapshot().messages[SESSION_ID]?.[0]?.role === 'system')
    expect(host!.seen[0]!.mode).toBe('raw')
    expect(host!.mock.lastCompress()).toEqual({ sessionId: SESSION_ID, mode: 'raw' })
    // 产物形态也换了（不是「参数到了、电脑端没理」）
    expect(chatStore.getSnapshot().messages[SESSION_ID]![0]!.text).toContain('正文压缩')
  })

  it('点「AI 摘要压缩」→ 电脑侧走 ai', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    await connect()
    await openInfoSheet()

    click(button('AI 摘要压缩'))
    await waitFor(() => host!.seen.length > 0)
    expect(host!.seen[0]!.mode).toBe('ai')
    expect(host!.mock.lastCompress()).toEqual({ sessionId: SESSION_ID, mode: 'ai' })
  })

  it('二次确认点「取消」→ 一个字节都没发出去', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    await connect()
    await openInfoSheet()

    click(button('正文压缩'))
    await flush(30)
    expect(host!.seen).toHaveLength(0)
    expect(host!.mock.calls).not.toContain('host.session.compress')
    expect(host!.mock.lastCompress()).toBeNull()
  })
})

describe('压缩方式：旧电脑端（没声明 session.compress.mode）', () => {
  it('只给一个「压缩上下文」按钮，且**不传** mode（免得被静默丢掉）', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    // 旧电脑端：其余能力照旧，唯独不认识压缩方式
    await connect(['session.list', 'session.context', 'session.compress'])
    await openInfoSheet()

    expect(hasButton('压缩上下文')).toBe(true)
    expect(hasButton('AI 摘要压缩')).toBe(false)
    expect(hasButton('正文压缩')).toBe(false)

    click(button('压缩上下文'))
    await waitFor(() => host!.seen.length > 0)
    // 「没传」而不是「传了 ai」：真正生效的是电脑侧设置里的那一档，本端无从得知
    expect(host!.seen[0]!.mode).toBeUndefined()
    // 宿主按缺省走，所以产物仍是 ai 那句（与改动前一字不变）
    expect(host!.mock.lastCompress()).toEqual({ sessionId: SESSION_ID, mode: 'ai' })
  })

  it('本端在 hello 里声明了该能力名（协商的输入；名字来自共享包，不是手写字符串）', async () => {
    await connect()
    expect(host!.clientCaps).toContain(COMPRESS_MODE_CAPABILITY)
    expect(host!.clientCaps).toContain('session.compress')
    // 两端比对的必须是同一个字面量
    expect(COMPRESS_MODE_CAPABILITY).toBe('session.compress.mode')
  })
})
