/**
 * 手机端 M5 功能单测：停止 / 继续（resume）、分页 / 暂停态。
 * 与既有测试同套路：**memory transport + 共享包的 mock 宿主**，因此验证的是真实的
 * store → 协议 → 宿主 三条链路，而不是替身行为。重点覆盖两条容易写错的地方：
 *  1. **暂停态必须由电脑侧事件驱动**（手机不自行猜测）：`shelve` → `paused` 置起；
 *     `resume` → `paused` 清掉、`working` 置起。
 *  2. **分页游标原样回传**：首页给游标、续页带 `fromRowid`、合并按 id 去重、到底不再发请求。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  createMemoryPair,
  registerHostHandlers,
  type HostRegistration,
  type MemoryTransport,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource, type MockHostOptions } from 'virlen-remote/testing'
import { chatStore } from '../store/chat'
import { connectionStore } from '../store/connection'
import { devicesStore } from '../store/devices'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface HostHarness {
  hostT: MemoryTransport
  mobileT: MemoryTransport
  ep: Endpoint
  reg: HostRegistration
  mock: MockHostDataSource
}

let host: HostHarness | null = null

function setupHost(options: MockHostOptions = {}): HostHarness {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mock = createMockHostDataSource({ streamSteps: 2, streamDelayMs: 5, ...options })
  const reg = registerHostHandlers(ep, mock, { deviceName: 'Virlen 电脑（演示）' })
  mock.bind(reg.emit)
  return { hostT, mobileT, ep, reg, mock }
}

async function connect(options: MockHostOptions = {}): Promise<boolean> {
  host = setupHost(options)
  // 注入 transport → 不启用自动重连（那是 RTC 真实链路才需要的逻辑）
  return connectionStore.connect({
    hostId: 'demo-host',
    deviceName: '演示电脑',
    token: 'demo-token',
    transport: host.mobileT,
  })
}

async function waitForInteraction(interactionId: string): Promise<void> {
  const start = Date.now()
  while (!chatStore.getSnapshot().interactions.some((i) => i.interactionId === interactionId)) {
    if (Date.now() - start > 2000) throw new Error('waitForInteraction 超时')
    await flush(5)
  }
}

beforeEach(() => {
  chatStore.reset()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
})

afterEach(() => {
  connectionStore.disconnect()
  if (host) {
    host.reg.dispose()
    host.ep.dispose()
    host.hostT.close()
    host.mobileT.close()
    host = null
  }
})

// ───────────────────────────── 停止 / 继续 ─────────────────────────────

describe('M5 —— 停止与继续', () => {
  it('停止 → 请求到达电脑侧（host.session.cancel），且不写本地 error', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    await chatStore.cancel('demo-1')
    expect(host!.mock.calls).toContain('host.session.cancel')
    expect(chatStore.getSnapshot().error).toBeUndefined()
  })

  it('暂存 → 电脑侧推 paused；继续 → 请求到达电脑侧且 paused 清掉、working 置起', async () => {
    await connect()
    await chatStore.openSession('demo-1')

    const id = host!.mock.triggerInteraction({
      kind: 'authorization',
      permName: 'terminal.normal.execute',
    })
    await waitForInteraction(id)
    await chatStore.answer(id, 'shelve')
    await flush(10)

    // 暂停态来自电脑侧事件（手机不自行推断）
    expect(chatStore.getSnapshot().paused['demo-1']).toBe(true)
    expect(chatStore.getSnapshot().working['demo-1']).toBe(false)

    await chatStore.resume('demo-1')
    await flush(10)
    expect(host!.mock.calls).toContain('host.session.resume')
    expect(chatStore.getSnapshot().paused['demo-1']).toBe(false)
    expect(chatStore.getSnapshot().working['demo-1']).toBe(true)
  })
})

// ───────────────────────────── 分页 ─────────────────────────────

describe('M5 —— 消息分页', () => {
  it('首页给出游标；loadOlder 前插更早消息、游标前移、到底后不再发请求', async () => {
    await connect({ demoMessageCount: 120 })
    await chatStore.openSession('demo-1')

    let s = chatStore.getSnapshot()
    expect(s.messages['demo-1']).toHaveLength(50)
    expect(s.messages['demo-1'][0].id).toBe('m70')
    expect(s.hasMoreMessages['demo-1']).toBe(true)
    expect(s.cursor['demo-1']).toBe(70)

    await chatStore.loadOlder()
    s = chatStore.getSnapshot()
    expect(s.messages['demo-1']).toHaveLength(100)
    expect(s.messages['demo-1'][0].id).toBe('m20')
    expect(s.cursor['demo-1']).toBe(20)
    expect(s.hasMoreMessages['demo-1']).toBe(true)

    await chatStore.loadOlder()
    s = chatStore.getSnapshot()
    expect(s.messages['demo-1']).toHaveLength(120)
    expect(s.messages['demo-1'][0].id).toBe('m0')
    expect(s.hasMoreMessages['demo-1']).toBe(false)

    // 到底之后再调：不应再发请求，也不该出现重复气泡
    const before = host!.mock.calls.filter((c) => c.startsWith('host.session.messages')).length
    await chatStore.loadOlder()
    const after = host!.mock.calls.filter((c) => c.startsWith('host.session.messages')).length
    expect(after).toBe(before)
    expect(chatStore.getSnapshot().messages['demo-1']).toHaveLength(120)
  })

  it('续页确实带上游标（否则会反复取回同一页）', async () => {
    await connect({ demoMessageCount: 120 })
    await chatStore.openSession('demo-1')
    await chatStore.loadOlder()
    expect(host!.mock.calls).toContain('host.session.messages(older)')
  })

  it('已全量加载的会话：hasMore=false，loadOlder 不发请求', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    expect(chatStore.getSnapshot().hasMoreMessages['demo-1']).toBe(false)
    const before = host!.mock.calls.filter((c) => c.startsWith('host.session.messages')).length
    await chatStore.loadOlder()
    const after = host!.mock.calls.filter((c) => c.startsWith('host.session.messages')).length
    expect(after).toBe(before)
  })
})
