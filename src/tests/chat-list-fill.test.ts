/**
 * 「按可见行补足」的接线用例 —— 手机端的列表加载优化（与 `virlen-app` 提交 `eeda020` 的
 * `get_message_page_filled` 同一件事，只是这一层在**手机端**）。
 *
 * 问题（真机反馈）：取数若按**原始条数**给，工具调用密集的窗口在屏幕上只多一两行 —— 用户滚到
 * 顶部（或点「加载更早的消息」）却几乎看不到新内容，只能反复上滑 / 反复点。手机端的列表单位是
 * **行**（连续工具调用合成一行、纯工具调用轮的空正文消息根本不占行，见 `lib/message-rows.ts`），
 * 所以判据必须是「这一页会渲染成多少行」。
 *
 * 为什么要挂真实链路（memory transport + 共享包 mock 宿主）：这里要观测的正是**一次用户动作
 * 到底发了几个 RPC**，以及补足后的窗口 / 游标 / `hasMore` 对不对。纯函数层只能钉住「怎么数行」
 * （`message-rows.test.ts`）。
 *
 * 手法：**只改造 `host.session.messages` 的返回**（取数的唯一入口），把每一页伪装成工具密集的
 * 形态 —— 不动 mock 内部的会话 / 消息状态，订阅、游标、会话列表全都还是真在跑。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  createMemoryPair,
  registerHostHandlers,
  type HostRegistration,
  type MemoryTransport,
  type MessageDTO,
  type MsgPageDTO,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource } from 'virlen-remote/testing'
import { chatStore, MESSAGE_FILL_MAX_PAGES, MESSAGE_MIN_ROWS } from '../store/chat'
import { connectionStore } from '../store/connection'
import { devicesStore } from '../store/devices'
import { visibleRowCount } from '../lib/message-rows'

const SESSION = 'demo-1'

/** 一页 50 条在「工具密集」形态下渲染多少行（10 条可见 + 中间 10 段工具组）。 */
const ROWS_PER_DENSE_PAGE = 20

/** 一页伪装成哪种形态：工具密集（20 行/页）或整页工具结果（1 行/页）。 */
type Reshape = 'dense' | 'allTool'

interface HostHarness {
  hostT: MemoryTransport
  mobileT: MemoryTransport
  ep: Endpoint
  reg: HostRegistration
  mock: MockHostDataSource
}

let host: HostHarness | null = null

/**
 * 工具密集形态：每 5 条里 1 条看得见（有正文），其余是**空正文的工具结果**。
 *
 * 手机端对此的渲染：可见的那条各占 1 行，夹在中间的工具结果合成 1 段 —— 一页 50 条只有
 * `ROWS_PER_DENSE_PAGE` 行（正文密集时是 50 行）。mock 的页边界落在 5 的倍数上，故每页行数固定。
 */
function dense(messages: readonly MessageDTO[]): MessageDTO[] {
  return messages.map((m, i) =>
    i % 5 === 0
      ? { ...m, role: 'user', text: '看得见的一行' }
      : { ...m, role: 'tool', text: '', toolName: 'read_file', toolArgs: 'src/x.ts' },
  )
}

/** 整页都是工具结果：手机端 50 条 = 1 行 —— 用来钉「可见行永远涨不上去时靠上限收口」。 */
function allTool(messages: readonly MessageDTO[]): MessageDTO[] {
  return messages.map((m) => ({ ...m, role: 'tool', text: '', toolName: 'read_file' }))
}

async function connect(options: { messageCount?: number; reshape?: Reshape } = {}): Promise<void> {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mock = createMockHostDataSource({
    ...(options.messageCount != null ? { demoMessageCount: options.messageCount } : {}),
    streamDelayMs: 5,
  })
  const reshape = options.reshape
  if (reshape) {
    const original = mock.getMessages.bind(mock)
    mock.getMessages = async (params): Promise<MsgPageDTO> => {
      const page = await original(params)
      return { ...page, messages: reshape === 'dense' ? dense(page.messages) : allTool(page.messages) }
    }
  }
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

/** 已发出的窗口拉取次数（首屏与续页都算 —— 「补足」这件事本身就是多发几次）。 */
const pulls = (): number =>
  host!.mock.calls.filter((c) => c.startsWith('host.session.messages')).length

/** 本机窗口（升序）。 */
const window = (): MessageDTO[] => chatStore.getSnapshot().messages[SESSION] ?? []

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

describe('首屏窗口：按可见行补足', () => {
  it('一页只渲染 20 行 → 继续向更早取，直到 ≥50 行（游标停在实际取到的最旧一条）', async () => {
    await connect({ messageCount: 400, reshape: 'dense' })
    await chatStore.openSession(SESSION)

    // 尾部页 m350…m399（20 行）→ 再取两页才够 60 行
    expect(window()).toHaveLength(150)
    expect(window()[0].id).toBe('m250')
    expect(visibleRowCount(window())).toBe(3 * ROWS_PER_DENSE_PAGE)
    expect(visibleRowCount(window())).toBeGreaterThanOrEqual(MESSAGE_MIN_ROWS)
    expect(chatStore.getSnapshot().cursor[SESSION]).toBe(250)
    expect(chatStore.getSnapshot().hasMoreMessages[SESSION]).toBe(true)
    expect(pulls()).toBe(3)
  })

  it('正文密集的普通会话：一页就达标 → 一个多余的请求都不发', async () => {
    await connect({ messageCount: 120 })
    await chatStore.openSession(SESSION)

    expect(window()).toHaveLength(50)
    expect(window()[0].id).toBe('m70')
    expect(pulls()).toBe(1)
  })
})

describe('续页：一次动作取够，而不是把同一件事重复交给用户点', () => {
  it('一页只有 20 行 → 这一次点按连取 3 页；游标 / 窗口随之推进', async () => {
    await connect({ messageCount: 400, reshape: 'dense' })
    await chatStore.openSession(SESSION)
    const before = pulls()

    await chatStore.loadOlder()

    expect(pulls() - before).toBe(3)
    expect(window()).toHaveLength(300)
    expect(window()[0].id).toBe('m100')
    expect(chatStore.getSnapshot().cursor[SESSION]).toBe(100)
    expect(chatStore.getSnapshot().hasMoreMessages[SESSION]).toBe(true)
    // 中途提交会让续页锚点（按「行数长过加载前」判归位）只认到第一页，故只提交一次
    expect(chatStore.getSnapshot().loadingOlder).toBe(false)
  })

  it('正文密集：续页仍是一次请求（补足不会把它变贵）', async () => {
    await connect({ messageCount: 120 })
    await chatStore.openSession(SESSION)
    await chatStore.loadOlder()

    expect(window()).toHaveLength(100)
    expect(window()[0].id).toBe('m20')
    expect(pulls()).toBe(2)
  })

  it('到底即停：最后一页不足 50 行也不再多取（hasMore 已是 false）', async () => {
    await connect({ messageCount: 120 })
    await chatStore.openSession(SESSION)
    await chatStore.loadOlder()
    const before = pulls()

    await chatStore.loadOlder() // 尾页 m0…m19：20 行，但已到底

    expect(pulls() - before).toBe(1)
    expect(window()).toHaveLength(120)
    expect(window()[0].id).toBe('m0')
    expect(chatStore.getSnapshot().hasMoreMessages[SESSION]).toBe(false)
    expect(chatStore.getSnapshot().cursor[SESSION]).toBeNull()
  })
})

describe('上限兜底：可见行数永远涨不上去时不能无限取', () => {
  it('整页都是工具结果（50 条 = 1 行）→ 取满 MESSAGE_FILL_MAX_PAGES 页就收手', async () => {
    await connect({ messageCount: 400, reshape: 'allTool' })
    await chatStore.openSession(SESSION)

    expect(pulls()).toBe(MESSAGE_FILL_MAX_PAGES)
    expect(window()).toHaveLength(MESSAGE_FILL_MAX_PAGES * 50)
    // 一整段连续工具调用：取回 250 条，屏幕上仍是 1 行 —— 这正是要靠上限收口的情形
    expect(visibleRowCount(window())).toBe(1)
    expect(chatStore.getSnapshot().hasMoreMessages[SESSION]).toBe(true)
    expect(chatStore.getSnapshot().cursor[SESSION]).toBe(400 - MESSAGE_FILL_MAX_PAGES * 50)
  })
})
