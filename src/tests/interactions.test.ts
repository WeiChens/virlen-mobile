/**
 * 手机端「交互应答 + 会话写操作」单测（M4）。
 * 与 `mobile-stores.test.ts` 同一套路：用 **memory transport** 注入、对端是共享包的 mock 宿主
 * （`virlen-remote/testing`），因此这些用例验证的是**真实的 store → 协议 → 宿主**三条链路，
 * 而不是替身行为。重点覆盖两条容易写错的规则：
 *  1. **高风险必须带 `confirmed`**：缺标记时电脑侧拒（`confirm-required`），
 *     此时卡片**不能**被收起（用户还没走完二次确认）；
 *  2. **交互可能随时失效**：电脑侧先处理（`interaction.resolved`）或应答晚到（`not-found`），
 *     都只提示、不报错，并且不再留下点不动的卡片。
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
  const mock = createMockHostDataSource({ streamSteps: 2, streamDelayMs: 5 })
  const reg = registerHostHandlers(ep, mock, { deviceName: 'Virlen 电脑（演示）' })
  mock.bind(reg.emit)
  return { hostT, mobileT, ep, reg, mock }
}

async function connect(): Promise<boolean> {
  host = setupHost()
  return connectionStore.connect({
    hostId: 'demo-host',
    deviceName: '演示电脑',
    token: 'demo-token',
    transport: host.mobileT,
  })
}

/** 等 store 里出现某个交互（事件是异步投递的）。 */
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

// ───────────────────────────── 交互：事件 → 缓存 ─────────────────────────────

describe('chatStore —— 交互投影', () => {
  it('interaction.requested → 进入待应答列表；resolved → 移除（含电脑侧先处理）', async () => {
    await connect()
    const id = host!.mock.triggerInteraction({ tier: 'low' })
    await waitForInteraction(id)
    expect(chatStore.getSnapshot().interactions.map((i) => i.interactionId)).toContain(id)

    // 重复推送同一 id 不应产生两条（电脑侧可能因重连重放）
    host!.mock.triggerInteraction // 不使用，仅保留可读性
    chatStore.applyEvent('host.event.interaction.requested', {
      interaction: chatStore.getSnapshot().interactions[0],
    })
    expect(chatStore.getSnapshot().interactions).toHaveLength(1)

    chatStore.applyEvent('host.event.interaction.resolved', { interactionId: id, by: 'host' })
    expect(chatStore.getSnapshot().interactions).toHaveLength(0)
  })

  it('refreshInteractions → 补齐错过的交互（如手机在交互发起之后才连上）', async () => {
    await connect()
    const id = host!.mock.triggerInteraction({ tier: 'low' })
    await waitForInteraction(id)

    // 模拟「本地从未收到 requested」（重连 / 冷启动）：直接把它从本地投影里抹掉
    chatStore.applyEvent('host.event.interaction.resolved', { interactionId: id, by: 'host' })
    expect(chatStore.getSnapshot().interactions).toHaveLength(0)

    // 快照拉取必须把它找回来 —— 否则手机界面上「没有任何可点的东西」，用户只能干等
    await chatStore.refreshInteractions()
    expect(chatStore.getSnapshot().interactions.map((i) => i.interactionId)).toContain(id)

    // 服务端已不再挂起的僵尸条目：拉取后应被丢掉
    await chatStore.answer(id, 'allow')
    await chatStore.refreshInteractions()
    expect(chatStore.getSnapshot().interactions).toHaveLength(0)
  })
})

// ───────────────────────────── 交互：应答 ─────────────────────────────

describe('chatStore —— 应答', () => {
  it('低风险允许 → 被接受，卡片收起', async () => {
    await connect()
    const id = host!.mock.triggerInteraction({ tier: 'low', permName: 'terminal.normal.execute' })
    await waitForInteraction(id)

    const ok = await chatStore.answer(id, 'allow')
    expect(ok).toBe(true)
    expect(chatStore.getSnapshot().interactions).toHaveLength(0)
    expect(chatStore.getSnapshot().notice).toBeUndefined()
  })

  it('高风险缺 confirmed → 拒绝 + 提示；卡片**必须留着**（用户还没走完二次确认）', async () => {
    await connect()
    const id = host!.mock.triggerInteraction({
      tier: 'high',
      permName: 'sandbox.command.execute',
      sandboxBypass: true,
      desc: 'pnpm vitest run',
    })
    await waitForInteraction(id)

    const ok = await chatStore.answer(id, 'allow')
    expect(ok).toBe(false)
    expect(chatStore.getSnapshot().notice).toContain('二次确认')
    expect(chatStore.getSnapshot().interactions.map((i) => i.interactionId)).toContain(id)
  })

  it('高风险带 confirmed → 被接受，卡片收起', async () => {
    await connect()
    const id = host!.mock.triggerInteraction({ tier: 'high', permName: 'script.execute' })
    await waitForInteraction(id)

    const ok = await chatStore.answer(id, 'allow', { confirmed: true })
    expect(ok).toBe(true)
    expect(chatStore.getSnapshot().interactions).toHaveLength(0)
  })

  it('已失效的交互（not-found）→ 提示「已在电脑上处理」并收起卡片', async () => {
    await connect()
    const ok = await chatStore.answer('no-such-interaction', 'deny')
    expect(ok).toBe(false)
    expect(chatStore.getSnapshot().notice).toContain('已在电脑上处理')
  })

  it('AI 提问：选择结果被接受', async () => {
    await connect()
    const id = host!.mock.triggerInteraction({
      kind: 'choice',
      question: '选哪个？',
      options: ['A', 'B'],
    })
    await waitForInteraction(id)
    // 提问无论风险等级都应可一次应答
    const ok = await chatStore.answer(id, 'choose', { value: { selected: ['B'], customReply: '' } })
    expect(ok).toBe(true)
    expect(chatStore.getSnapshot().interactions).toHaveLength(0)
  })

  it('AI 提问 + 「取消」(deny) → 被接受，卡片收起（真机反馈回归）', async () => {
    await connect()
    const id = host!.mock.triggerInteraction({
      kind: 'choice',
      question: '选哪个？',
      options: ['A', 'B'],
    })
    await waitForInteraction(id)

    // 修复前：真实电脑端会把“提问 + 取消”判成 unsupported-by-host（mock 却放行，单测测不出来）
    const ok = await chatStore.answer(id, 'deny')
    expect(ok).toBe(true)
    expect(chatStore.getSnapshot().interactions).toHaveLength(0)
    expect(chatStore.getSnapshot().notice).toBeUndefined()
  })

  it('动作与交互类型不匹配（提问发 allow）→ unsupported-by-host，且卡片仍在', async () => {
    await connect()
    const id = host!.mock.triggerInteraction({ kind: 'choice', options: ['A'] })
    await waitForInteraction(id)

    const ok = await chatStore.answer(id, 'allow')
    expect(ok).toBe(false)
    expect(chatStore.getSnapshot().notice).toContain('不支持')
    expect(chatStore.getSnapshot().interactions.map((i) => i.interactionId)).toContain(id)
  })

  it('提问空选择 → invalid-value 提示（不给引擎发空回执）', async () => {
    await connect()
    const id = host!.mock.triggerInteraction({ kind: 'choice', options: ['A'] })
    await waitForInteraction(id)
    const ok = await chatStore.answer(id, 'choose', { value: { selected: [], customReply: '' } })
    expect(ok).toBe(false)
    expect(chatStore.getSnapshot().notice).toContain('不能为空')
  })
})

// ───────────────────────────── 会话写操作 ─────────────────────────────

describe('chatStore —— 会话写操作', () => {
  it('新建会话 → 列表出现并切过去', async () => {
    await connect()
    await chatStore.loadSessions()
    const before = chatStore.getSnapshot().sessions.length

    await chatStore.createSession('手机新建')
    const s = chatStore.getSnapshot()
    expect(s.sessions.length).toBe(before + 1)
    expect(s.currentSessionId).toBe(s.sessions[0].id)
  })

  it('重命名 / 置顶 →列表反映（目标态语义）', async () => {
    await connect()
    await chatStore.loadSessions()

    expect(await chatStore.renameSession('demo-1', '改过的名字')).toBe(true)
    await chatStore.setPinned('demo-1', true)

    const s = chatStore.getSnapshot().sessions.find((x) => x.id === 'demo-1')!
    expect(s.title).toBe('改过的名字')
    expect(s.pinned).toBe(true)
  })

  it('删除会话 → 当前会话被清空并从列表移除', async () => {
    await connect()
    await chatStore.loadSessions()
    await chatStore.openSession('demo-2')

    await chatStore.deleteSession('demo-2')
    const s = chatStore.getSnapshot()
    expect(s.sessions.some((x) => x.id === 'demo-2')).toBe(false)
    expect(s.currentSessionId).toBeNull()
  })
})
