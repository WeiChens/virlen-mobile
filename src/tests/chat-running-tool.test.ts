/**
 * 尾部「正在执行」的工具行（`RuntimeDTO.runningTools`）—— 手机端这一半。
 *
 * 真机反馈（2026-10）：「工具在电脑上有显示（呼吸点卡片），手机上只看到『正在思考』」。
 * 电脑侧把「已声明、结果还没到」的调用推下来了（见 `virlen-app` 的 `phone-running-tools.test.ts`），
 * 本文件盯住手机端**是否真的把它摆上屏**、摆成什么样：
 *
 * 1. 一行一个工具：`正在执行 read_file · src/store/chat.ts`（工具名 + 电脑侧给的入参摘要）；
 * 2. 有它时**不再**同时显示「正在思考…」占位（两个状态打架，用户会以为卡住了）；
 * 3. 它与**流式正文并存**（模型常常先说一句再调工具）：正文在上、工具行在下 —— 与电脑同一次序；
 * 4. 电脑侧收工时（字段缺席）那几行必须消失，否则会留一行永远「正在执行」的僵尸；
 * 5. 暂停态不显示（暂停时那些没结果的调用是「等继续」，不是「正在执行」）。
 *
 * 为什么必须挂真实组件：整体是 DOM 形态（行数 / 文案 / 与正文的先后），纯函数测不到
 * （纯函数那一半在 `session-config-helpers.test.ts`）。
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
  const mock = createMockHostDataSource({ streamDelayMs: 15 })
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

/** 尾部的工具行（`.running-tool`）。 */
function rows(): HTMLElement[] {
  return [...(container?.querySelectorAll<HTMLElement>('.running-tools .running-tool') ?? [])]
}

/** 尾部整块（判断它的子节点先后顺序）。 */
function foot(): HTMLElement | null {
  return container?.querySelector<HTMLElement>('.chat__list-foot') ?? null
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

describe('尾部「正在执行」的工具行', () => {
  it('电脑侧推 runningTools → 一行一个工具（工具名 + 入参摘要）；收工后一行不留', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    await waitFor(() => (chatStore.getSnapshot().messages['demo-1'] ?? []).length > 0)

    mount()
    await act(async () => {
      await flush(20)
    })

    host!.mock.setRunningTools('demo-1', [
      { toolCallId: 'tc-1', name: 'read_file', args: 'src/store/chat.ts' },
      { toolCallId: 'tc-2', name: 'execute_command', args: 'pnpm vitest run' },
    ])
    await waitFor(() => rows().length === 2)
    expect(rows()[0].textContent).toContain('正在执行 read_file · src/store/chat.ts')
    expect(rows()[1].textContent).toContain('正在执行 execute_command · pnpm vitest run')
    /*
     * 有具体动作在跑时不该再挂一句「正在思考…」占位（两个状态打架 = 看起来像卡死）。
     * 判据钉在**占位气泡本身不出现**上，而不是某句文案：`pendingLabel` 在没有流式态时
     * 给的是「AI 正在处理…」，只比字符串会漏掉这一半。
     */
    expect(container!.querySelector('.msg__bubble--pending')).toBeNull()
    expect(container!.textContent).not.toContain('正在思考…')

    // 收工：电脑侧不再下发该字段 → 行消失（否则就是一行永远「正在执行」的僵尸）
    host!.mock.setRunningTools('demo-1', null)
    await waitFor(() => rows().length === 0)
  })

  it('与流式正文并存：正文在上、工具行在下（与电脑同一次序）', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    await waitFor(() => (chatStore.getSnapshot().messages['demo-1'] ?? []).length > 0)

    mount()
    await act(async () => {
      await flush(20)
    })

    act(() => {
      chatStore.applyEvent('host.event.message.stream', {
        sessionId: 'demo-1',
        messageId: 'live-1',
        seq: 1,
        mode: 'full',
        text: '我先看下这个文件。',
        final: false,
      })
    })
    host!.mock.setRunningTools('demo-1', [{ toolCallId: 'tc-1', name: 'read_file', args: 'a.ts' }])
    await waitFor(() => rows().length === 1)

    const bubbles = [...(foot()!.querySelectorAll<HTMLElement>('.msg__bubble--stream') ?? [])]
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0].textContent).toContain('我先看下这个文件。')
    // 正文 + 工具行并存时同样不出现占位气泡
    expect(container!.querySelector('.msg__bubble--pending')).toBeNull()
    // 正文气泡在 DOM 里排在工具行**之前**（尾部是纵向排列，顺序即视觉顺序）
    const all = [...foot()!.children]
    const bodyIdx = all.findIndex((el) => el.contains(bubbles[0]))
    const rowsIdx = all.findIndex((el) => el.contains(rows()[0]))
    expect(bodyIdx).toBeGreaterThanOrEqual(0)
    expect(rowsIdx).toBeGreaterThan(bodyIdx)
  })

  it('暂停态不显示（那些没结果的调用是「等继续」，不是「正在执行」）', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    await waitFor(() => (chatStore.getSnapshot().messages['demo-1'] ?? []).length > 0)

    mount()
    await act(async () => {
      await flush(20)
    })

    act(() => {
      chatStore.applyEvent('host.event.session.runtime.changed', {
        sessionId: 'demo-1',
        runtime: {
          working: true,
          paused: true,
          runningTools: [{ toolCallId: 'tc-1', name: 'read_file', args: 'a.ts' }],
        },
      })
    })
    await flush(30)
    expect(rows()).toHaveLength(0)

    // 继续（不再暂停）→ 行回来
    act(() => {
      chatStore.applyEvent('host.event.session.runtime.changed', {
        sessionId: 'demo-1',
        runtime: {
          working: true,
          runningTools: [{ toolCallId: 'tc-1', name: 'read_file', args: 'a.ts' }],
        },
      })
    })
    await waitFor(() => rows().length === 1)
    expect(rows()[0].textContent).toContain('正在执行 read_file · a.ts')
  })
})
