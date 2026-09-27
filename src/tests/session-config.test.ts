/**
 * 手机端 §22 功能单测：新对话（延迟创建）/ 模型 / 工作目录 / 上下文 / 压缩 / 流式。
 *
 * 与既有测试同套路：**memory transport + 共享包的 mock 宿主**，验证的是真实的
 * store → 协议 → 宿主 三条链路。重点覆盖四处最容易写错的地方：
 *
 *  1. **「新对话」不创建会话**：点「＋」只清空当前会话，**发第一条消息**才 create（用户拍板）。
 *
 *  2. **越权目录由电脑侧拦**：手机即使硬塞一个候选集外的目录，也只能拿到 `E_BAD_REQUEST`
 *     （不能靠「手机端不显示」当隔离）；
 *  3. **压缩需要确认 + 完成后重拉窗口**：`messages.reset` → 本地丢缓存重拉，不留幽灵消息。
 *  4. **流式正文真的在推**：中间态比最终文本短（这条在电脑侧曾经整条断掉，见 §22.4）。
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
  const mock = createMockHostDataSource({ streamSteps: 2, streamDelayMs: 15, ...options })
  const reg = registerHostHandlers(ep, mock, { deviceName: 'Virlen 电脑（演示）' })
  mock.bind(reg.emit)
  return { hostT, mobileT, ep, reg, mock }
}

async function connect(options: MockHostOptions = {}): Promise<boolean> {
  host = setupHost(options)
  return connectionStore.connect({
    hostId: 'demo-host',
    deviceName: '演示电脑',
    token: 'demo-token',
    transport: host.mobileT,
  })
}

/** 轮询直到条件成立（内存传输的事件投递是异步的）。 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

const countCalls = (method: string): number =>
  host!.mock.calls.filter((c) => c === method).length

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

// ───────────────────────── 新对话：发送才创建 ─────────────────────────

describe('§22 —— 「新对话」延迟创建', () => {
  it('点「＋」不创建会话（电脑侧无任何调用）；发消息时才 create + send', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    await flush(10)

    // 草稿默认取「最近一个会话」的模型 / 目录（与桌面同思路）
    expect(chatStore.getSnapshot().draft.workspace).toBe('E:/code/virlen-demo')
    expect(chatStore.getSnapshot().draft.modelId).toBe('gpt-4o')

    chatStore.newChat()
    expect(chatStore.getSnapshot().currentSessionId).toBeNull()
    expect(countCalls('host.session.create')).toBe(0)

    await chatStore.send('第一条消息')
    await flush(20)
    expect(countCalls('host.session.create')).toBe(1)
    expect(countCalls('host.session.send')).toBe(1)

    const snap = chatStore.getSnapshot()
    const created = snap.sessions.find((s) => s.id === snap.currentSessionId)
    expect(created).toBeTruthy()
    expect(created!.workspace).toBe('E:/code/virlen-demo')
    expect(created!.modelId).toBe('gpt-4o')
  })

  it('新对话选的目录会带给电脑侧（只改草稿、不发请求）', async () => {
    await connect()
    await flush(10)
    chatStore.newChat()
    chatStore.setDraftWorkspace('E:/code/another-project')
    expect(countCalls('host.session.create')).toBe(0)

    await chatStore.send('在另一个目录开的')
    await flush(20)
    const snap = chatStore.getSnapshot()
    expect(snap.sessions.find((s) => s.id === snap.currentSessionId)!.workspace).toBe(
      'E:/code/another-project',
    )
  })

  it('越权目录 → 电脑侧拒（E_BAD_REQUEST），且不产生会话', async () => {
    await connect()
    await flush(10)
    chatStore.newChat()
    // 模拟「手机端被改过 / 被伪造」：硬塞一个电脑侧候选集里没有的目录
    chatStore.setDraftWorkspace('C:/windows')

    const before = chatStore.getSnapshot().sessions.length
    await chatStore.send('越权尝试')
    await flush(20)

    expect(chatStore.getSnapshot().error).toBeTruthy()
    expect(chatStore.getSnapshot().sessions).toHaveLength(before)
    expect(chatStore.getSnapshot().currentSessionId).toBeNull()
  })

  it('无会话时切换模型只改草稿（不打扰电脑侧）', async () => {
    await connect()
    await flush(10)
    chatStore.newChat()
    const before = countCalls('host.session.setModel')

    await chatStore.setModel('p-anthropic', 'claude-sonnet-4')
    expect(countCalls('host.session.setModel')).toBe(before)
    expect(chatStore.getSnapshot().draft).toMatchObject({
      providerConfigId: 'p-anthropic',
      modelId: 'claude-sonnet-4',
    })
  })

  /**
   * ⚠️ 回归（2026-09-29 真机缺陷，§24）：真机上「新建会话 → 发第一条消息」后
   * **标题变了、消息永远空白**。
   *
   * 根因不在渲染层：电脑侧只把消息 / 流式 / 运行时推给**已订阅**的会话
   * （恒推的只有会话列表 —— 所以标题能到手机），而「创建会话」这条路径上没有 subscribe。
   * 本用例断言的就是用户看到的东西：那条消息真的出现在列表里，且流式中间态真的流过。
   */
  it('新会话第一条消息：用户消息 / 流式中间态 / 定稿都到达手机', async () => {
    await connect()
    await flush(10)
    chatStore.newChat()

    await chatStore.send('第一条消息')
    const id = chatStore.getSnapshot().currentSessionId
    expect(id).toBeTruthy()

    // 1) 自己发出的那条消息（电脑侧 message.added）
    await waitFor(() =>
      (chatStore.getSnapshot().messages[id!] ?? []).some((m) => m.text === '第一条消息'),
    )

    // 2) 流式正文与定稿（订阅门漏了的话，这两样一个都不会来）
    const seen: string[] = []
    for (let i = 0; i < 80; i++) {
      const st = chatStore.getSnapshot().streaming[id!]
      if (st?.text) seen.push(st.text)
      if (chatStore.getSnapshot().messages[id!]?.some((m) => m.text.includes('第 2 段'))) break
      await flush(10)
    }
    expect(seen.length).toBeGreaterThan(0)
    expect(
      chatStore.getSnapshot().messages[id!].some((m) => m.role === 'assistant' && m.text.includes('第 2 段')),
    ).toBe(true)
  })

  /**
   * 接线顺序（§24）：**订阅必须先于发送落地**。
   *
   * 为何敢断言顺序：电脑侧是在「订阅应答」之前完成登记的（`await activateSession` 之后
   * `subscriptions.add`），所以「`openSession` 返回 → 订阅已生效」；而发送早于订阅时，
   * 首条消息、流式、working 会在**没有任何报错**的情况下全部丢掉（就是上面那个真机缺陷）。
   */
  it('接线顺序：create → subscribe → messages → send', async () => {
    await connect()
    await flush(10)
    chatStore.newChat()
    await chatStore.send('顺序')

    const seq = host!.mock.calls.filter((c) =>
      ['host.session.create', 'host.session.subscribe', 'host.session.messages', 'host.session.send'].includes(c),
    )
    expect(seq).toEqual([
      'host.session.create',
      'host.session.subscribe',
      'host.session.messages',
      'host.session.send',
    ])
  })
})

/**
 * §22 —— 版本兼容（**老电脑 + 新 PWA**）。
 *
 * PWA 总是最新的，而电脑端可能是旧版本 —— 旧电脑没有的能力对应的新请求必须**静默不发**。
 * 否则用户会在界面上看到一堆「未授权 / 不支持」的错误条（而其实什么都没做错）。
 */
describe('§22 —— 能力缺失时静默不发新请求', () => {
  it('没有 session.context / session.model 能力 → 不请求快照与模型清单', async () => {
    await connect()
    // 模拟电脑端只具备 M4 能力（旧版本）
    chatStore.setCapabilities(['session.list', 'session.send', 'interaction.answer'])
    const beforeContext = countCalls('host.session.context')
    const beforeModels = countCalls('host.model.list')

    await chatStore.loadContext('demo-1')
    await chatStore.loadModels()
    await chatStore.compressContext('demo-1')
    await chatStore.openSession('demo-1')
    await flush(20)

    expect(countCalls('host.session.context')).toBe(beforeContext)
    expect(countCalls('host.model.list')).toBe(beforeModels)
    expect(countCalls('host.session.compress')).toBe(0)
    // 也不应该留下错误条（这就是「静默」的含义）
    expect(chatStore.getSnapshot().error).toBeUndefined()
  })
})

// ───────────────────────── 已有会话：切模型 ─────────────────────────

describe('§22 —— 切换模型（已有会话）', () => {
  it('切模型落到电脑侧，列表随之更新；未知模型被拒', async () => {
    await connect()
    await chatStore.openSession('demo-2')
    await flush(10)

    await chatStore.setModel('p-openai', 'gpt-4o-mini')
    await waitFor(
      () => chatStore.getSnapshot().sessions.find((s) => s.id === 'demo-2')!.modelId === 'gpt-4o-mini',
    )

    // 电脑侧只认「已启用服务 + 该服务下存在的模型」
    await chatStore.setModel('p-openai', '不存在的模型')
    await waitFor(() => !!chatStore.getSnapshot().error)
    expect(chatStore.getSnapshot().sessions.find((s) => s.id === 'demo-2')!.modelId).toBe(
      'gpt-4o-mini',
    )
  })

  it('模型清单来自电脑侧（白名单投影），拉取后可复用缓存', async () => {
    await connect()
    await chatStore.loadModels()
    expect(countCalls('host.model.list')).toBe(1)
    expect(chatStore.getSnapshot().models.map((p) => p.id)).toEqual(['p-openai', 'p-anthropic'])

    // 已缓存 → 不再请求
    await chatStore.loadModels()
    expect(countCalls('host.model.list')).toBe(1)
  })
})

// ───────────────────────── §24：订阅先于快照 ─────────────────────────

/**
 * 「订阅」是手机端能看到消息的**前提**（电脑侧只推已订阅的会话）。
 *
 * 顺序要求：订阅请求必须先发出、且必须在返回前落地 —— 「快照 → 订阅」之间的窗口里产生的
 * 消息事件会被订阅门拦掉且**永不再补**（界面停在一份过期快照上，且没有任何提示）。
 */
describe('§24 —— 进入会话：先订阅，再快照', () => {
  it('openSession：subscribe 先于 messages，且返回时订阅已生效', async () => {
    await connect()
    const before = countCalls('host.session.subscribe')
    await chatStore.openSession('demo-2')

    expect(countCalls('host.session.subscribe')).toBe(before + 1)
    const seq = host!.mock.calls.filter(
      (c) => c === 'host.session.subscribe' || c === 'host.session.messages',
    )
    expect(seq[0]).toBe('host.session.subscribe')
    expect(seq[1]).toBe('host.session.messages')
  })

  it('openSession 之后电脑侧推的变化能到达（订阅真的生效了，不只是“发出去了”）', async () => {
    await connect()
    await chatStore.openSession('demo-1')

    // 未订阅时这条推送会被订阅门拦掉（见共享包的「订阅门」用例）
    host!.mock.bumpContext('demo-1', 160_000)
    await waitFor(() => chatStore.getSnapshot().context['demo-1']?.tokens === 160_000)
  })
})

// ───────────────────────── 上下文与压缩 ─────────────────────────

describe('§22 —— 上下文占用与压缩', () => {
  it('打开会话拉快照；电脑侧推变化后本地百分比跟着变', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    await waitFor(() => !!chatStore.getSnapshot().context['demo-1'])

    expect(chatStore.getSnapshot().context['demo-1']).toEqual({
      tokens: 120_000,
      windowTokens: 200_000,
    })

    // 电脑侧推一次占用变化（真实场景：又跑了一轮 / 用户压缩过）
    host!.mock.bumpContext('demo-1', 180_000)
    await waitFor(() => chatStore.getSnapshot().context['demo-1']?.tokens === 180_000)
  })

  it('压缩：带 confirm 的请求到达电脑侧；完成后走 messages.reset 重拉（只剩摘要）', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    await waitFor(() => (chatStore.getSnapshot().messages['demo-1'] ?? []).length === 2)

    const ok = await chatStore.compressContext('demo-1')
    expect(ok).toBe(true)
    await flush(30)

    const snap = chatStore.getSnapshot()
    // 压缩后电脑侧只剩一条摘要（手机端必须重拉，否则会一直显示幽灵消息）
    expect(snap.messages['demo-1']).toHaveLength(1)
    expect(snap.messages['demo-1'][0].role).toBe('system')
    expect(snap.messages['demo-1'][0].text).toContain('上下文摘要')
    // 占用回到压缩后的水平
    await waitFor(() => chatStore.getSnapshot().context['demo-1']?.tokens === 2_000)
  })

  it('占用充裕的会话：压缩被电脑侧拒，本地记错误（不静默）', async () => {
    await connect()
    await chatStore.openSession('demo-2')
    await waitFor(() => !!chatStore.getSnapshot().context['demo-2'])

    const ok = await chatStore.compressContext('demo-2')
    expect(ok).toBe(false)
    expect(chatStore.getSnapshot().error).toBeTruthy()
  })
})

// ───────────────────────── 流式正文 ─────────────────────────

describe('§22 —— 流式正文（真机缺陷回归）', () => {
  it('发送后能观察到逐帧变长的中间态，定稿后 streaming 清空且完整消息入列表', async () => {
    await connect()
    await chatStore.openSession('demo-1')
    await chatStore.send('流式测试')

    const seen: string[] = []
    for (let i = 0; i < 60; i++) {
      const st = chatStore.getSnapshot().streaming['demo-1']
      if (st?.text) seen.push(st.text)
      if (chatStore.getSnapshot().messages['demo-1']?.some((m) => m.text.includes('第 2 段'))) break
      await flush(10)
    }

    // 中间态必须出现过：只推最终结果 = 手机端只有「加载中」（就是被修掉的那个缺陷）
    expect(seen.length).toBeGreaterThan(0)
    const finalText = seen[seen.length - 1]
    expect(seen.some((t) => t.length < finalText.length)).toBe(true)

    await waitFor(() => chatStore.getSnapshot().streaming['demo-1'] === undefined)
    const snap = chatStore.getSnapshot()
    expect(snap.streaming['demo-1']).toBeUndefined()
    expect(snap.messages['demo-1'].some((m) => m.role === 'assistant' && m.text.includes('第 2 段'))).toBe(
      true,
    )
  })

  it('工具参数生成进度到达手机（§27）：落到 store，清空也生效', async () => {
    // 回归背景：模型写大参数（如 2000 字的 `write_file`）时，引擎在参数累积期**零事件**；
    // 手机端正文一动不动（真机表现为「一小段之后停住，结束才补全」）。
    await connect()
    await chatStore.openSession('demo-1')
    await flush(10)

    host!.mock.setToolProgress('demo-1', { name: 'write_file', chars: 1200 })
    await waitFor(() => chatStore.getSnapshot().toolProgress['demo-1']?.chars === 1200)
    expect(chatStore.getSnapshot().toolProgress['demo-1']).toEqual({
      name: 'write_file',
      chars: 1200,
    })

    // 工具开始执行 / 本轮结束 → 清空也必须到达（否则界面一直挂着「正在生成…」）
    host!.mock.setToolProgress('demo-1', null)
    await waitFor(() => chatStore.getSnapshot().toolProgress['demo-1'] === undefined)
  })
})
