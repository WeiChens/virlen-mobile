/**
 * 手机端「纯逻辑」单测（M2 补充）。
 * 不依赖 WebRTC / BroadcastChannel：用 **memory transport** 注入
 * （`connectionStore.connect({ transport })`），对端是共享包的 **mock 宿主**
 * （`virlen-remote/testing`）。覆盖三块：
 *  1. `connectionStore` —— 连接状态机（成功 / 令牌过期 / 设备被移除 / 不在线 / 断开）
 *  2. `chatStore` —— 会话列表 / 打开会话拉消息 / 发送 + 流式收口
 *  3. `chatStore.applyEvent` —— 事件 → 缓存的纯函数行为（幂等 / 流式 final 清空）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  MemoryTransport,
  createMemoryPair,
  registerHostHandlers,
  type HostRegistration,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource } from 'virlen-remote/testing'
import { connectionStore } from '../store/connection'
import { chatStore } from '../store/chat'
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

function setupHost(): HostHarness {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mock = createMockHostDataSource({ streamSteps: 3, streamDelayMs: 5 })
  const reg = registerHostHandlers(ep, mock, { deviceName: 'Virlen 电脑（演示）' })
  mock.bind(reg.emit)
  return { hostT, mobileT, ep, reg, mock }
}

/** 连到一台 mock 电脑；返回是否成功。 */
async function connect(token = 'demo-token'): Promise<boolean> {
  host = setupHost()
  return connectionStore.connect({
    hostId: 'demo-host',
    deviceName: '演示电脑',
    token,
    transport: host.mobileT,
  })
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

// ───────────────────────────── 连接状态机 ─────────────────────────────

describe('connectionStore —— 连接状态机', () => {
  it('成功：hello 通过 → online，攒下设备记录与能力集', async () => {
    const ok = await connect()
    expect(ok).toBe(true)
    const s = connectionStore.getSnapshot()
    expect(s.status).toBe('online')
    expect(s.capabilities).toContain('session.list')
    expect(s.device).toMatchObject({ id: 'demo-host' })
    // M6：设备记录里存的是**电脑端回传的授权凭证**（不是手上那张一次性票据）
    const [device] = devicesStore.getSnapshot()
    expect(device.hostKey).toBe('demo-host')
    expect(device.grant).toBe('gt-demo')
    expect(device.expiresAt).toBeGreaterThan(Date.now())
  })

  it('凭证过期 → error / expired（手机端据此提示重新扫码）', async () => {
    const ok = await connect('expired')
    expect(ok).toBe(false)
    const s = connectionStore.getSnapshot()
    expect(s.status).toBe('error')
    expect(s.error?.reason).toBe('expired')
    // 被拒绝不应写入设备记录
    expect(devicesStore.getSnapshot()).toHaveLength(0)
  })

  it('设备被电脑端移除 → error / revoked', async () => {
    await connect('removed')
    expect(connectionStore.getSnapshot().error?.reason).toBe('revoked')
  })

  it('电脑不在线（链路不可用）→ error / offline', async () => {
    // 未配对的 transport 恒为 connecting（非 open）→ call 立即 E_TRANSPORT
    const dead = new MemoryTransport()
    const ok = await connectionStore.connect({
      hostId: 'offline-host',
      deviceName: '离线电脑',
      token: 't',
      transport: dead,
    })
    expect(ok).toBe(false)
    expect(connectionStore.getSnapshot().error?.reason).toBe('offline')
    dead.close()
  })

  it('disconnect → 回到 idle 且清空 chatStore', async () => {
    await connect()
    await chatStore.loadSessions()
    expect(chatStore.getSnapshot().sessions.length).toBeGreaterThan(0)

    connectionStore.disconnect()
    expect(connectionStore.getSnapshot().status).toBe('idle')
    expect(chatStore.getSnapshot().sessions).toHaveLength(0)
  })
})

// ───────────────────────────── 会话 / 消息 / 流式 ─────────────────────────────

describe('chatStore —— 会话 / 消息 / 流式', () => {
  it('loadSessions → 拉回会话列表', async () => {
    await connect()
    await chatStore.loadSessions()
    expect(chatStore.getSnapshot().sessions.map((s) => s.id)).toEqual(['demo-1', 'demo-2'])
  })

  it('openSession → 拉取消息并设为当前会话', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    const s = chatStore.getSnapshot()
    expect(s.currentSessionId).toBe('demo-1')
    expect(s.messages['demo-1']).toHaveLength(2)
    expect(s.messages['demo-1'][0].role).toBe('user')
  })

  it('send → 用户消息入列，流式回复以完整消息收口', async () => {
    await connect()
    await chatStore.openSession('demo-1')

    await chatStore.send('帮我看看')
    await flush(20)
    const afterSend = chatStore.getSnapshot().messages['demo-1']
    expect(afterSend.some((m) => m.role === 'user' && m.text === '帮我看看')).toBe(true)

    // 等待 mock 的流式走完（3 段 × 5ms + 收尾）
    await flush(120)
    const s = chatStore.getSnapshot()
    const list = s.messages['demo-1']
    const last = list[list.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.text).toContain('第 3 段')
    // 流式态已清空（final 收口）
    expect(s.streaming['demo-1']).toBeUndefined()
  })

  it('send 空文本 / 无当前会话 → 不报错也不发送', async () => {
    await connect()
    await chatStore.send('   ') // 无当前会话
    expect(chatStore.getSnapshot().messages).toEqual({})
  })
})

// ───────────────────────────── applyEvent 纯函数行为 ─────────────────────────────

describe('chatStore.applyEvent —— 事件 → 缓存', () => {
  it('added 幂等（同 id 不重复追加）；updated 原地更新', () => {
    const dto = { id: 'm1', role: 'assistant' as const, text: 'a', createdAt: 1 }
    chatStore.applyEvent('host.event.message.added', { sessionId: 'x', message: dto })
    chatStore.applyEvent('host.event.message.added', { sessionId: 'x', message: dto })
    expect(chatStore.getSnapshot().messages['x']).toHaveLength(1)

    chatStore.applyEvent('host.event.message.updated', {
      sessionId: 'x',
      message: { ...dto, text: 'ab' },
    })
    expect(chatStore.getSnapshot().messages['x'][0].text).toBe('ab')
  })

  it('stream：进行中记录 streaming；final 清空', () => {
    chatStore.applyEvent('host.event.message.stream', {
      sessionId: 'x',
      messageId: 'a1',
      seq: 1,
      mode: 'full',
      text: '你',
      final: false,
    })
    expect(chatStore.getSnapshot().streaming['x']).toMatchObject({ messageId: 'a1', text: '你', seq: 1 })

    chatStore.applyEvent('host.event.message.stream', {
      sessionId: 'x',
      messageId: 'a1',
      seq: 2,
      mode: 'full',
      text: '你好',
      final: true,
    })
    expect(chatStore.getSnapshot().streaming['x']).toBeUndefined()
  })

  it('runtime.changed 更新 working', () => {
    chatStore.applyEvent('host.event.session.runtime.changed', {
      sessionId: 'x',
      runtime: { working: true },
    })
    expect(chatStore.getSnapshot().working['x']).toBe(true)
  })

  it('list.changed 覆盖会话列表', () => {
    chatStore.applyEvent('host.event.session.list.changed', {
      sessions: [{ id: 's1', title: '一', updatedAt: 1, working: false }],
    })
    expect(chatStore.getSnapshot().sessions.map((s) => s.id)).toEqual(['s1'])
  })
})
