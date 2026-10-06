/**
 * 「进入手机端时默认打开哪个会话」的回归 —— 纯函数 + 真实内存链路 + mock 宿主，一个 RPC 都不 mock。
 *
 * 这条需求（用户拍板，2026-10）要修的是一个**没有任何报错**的缺陷：
 * 「每次打开手机都跑到一个几天没动的会话里」。根因不在「默认打开第一个」，而在
 * **列表顺序 = 置顶优先 → `updatedAt` 倒序** —— 那个「第一个」其实是**置顶**的那个。
 *
 * 所以这一层要钉住三件事：
 * 1. **正在工作的会话优先**（用户上一个动作多半就是它，回来第一眼要看它的进展）；
 * 2. 否则打开**最近更新**的那个 —— **置顶不参与**（置顶 = 「别让它被淹没」，不是「每次回来都进它」）；
 * 3. 反过来也要钉：**不是「不许打开置顶会话」**（置顶那个正好最近时，还是它），
 *    以及**已有当前会话时不抢**（链路抖动后的重新挂载不该把用户正看的会话换掉）。
 *
 * ⚠️ 演示宿主默认两条会话本来就按时序倒序，**测不出这个缺陷** —— 真机上「置顶的老会话排第一」
 * 才是触发条件，故这里自己造列表顺序（只覆盖 `listSessions` 的返回，其余 RPC 仍走真实 mock）。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
  createMemoryPair,
  registerHostHandlers,
  type HostRegistration,
  type MemoryTransport,
  type SessionSummaryDTO,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource } from 'virlen-remote/testing'
import Chat from '../ui/pages/Chat'
import { pickEntrySession } from '../lib/session-entry'
import { chatStore } from '../store/chat'
import { connectionStore } from '../store/connection'
import { devicesStore } from '../store/devices'
import { linkStore } from '../store/link'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** mock 宿主里那两条会话（标题是「打开了哪一个」在 DOM 上的可认标记）。 */
const RECENT = 'demo-1'
const RECENT_TITLE = '演示：手机控制'
const OLD = 'demo-2'
const OLD_TITLE = '空会话'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 轮询直到条件成立（内存传输的事件投递是异步的）。
 *
 * ⚠️ 整段包在 `act` 里：等待期间到达的事件会改 React 状态，不包的话每一条都吐一行 act 警告，
 * 真正的失败信息会被淹掉。
 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  await act(async () => {
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
      await flush(5)
    }
  })
}

/** 造一条 DTO（只写这条需求关心的字段：时间 / 置顶 / 是否在工作）。 */
function session(
  id: string,
  title: string,
  updatedAt: number,
  extra: Partial<SessionSummaryDTO> = {},
): SessionSummaryDTO {
  return { id, title, updatedAt, working: false, pinned: false, ...extra }
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

/**
 * 连上一台「列表顺序由用例指定」的演示电脑。
 *
 * 为什么列表要由用例给：缺陷只存在于**特定顺序 + 特定状态**的组合里（置顶的更旧还排第一），
 * 而真实电脑侧的顺序正是那样排的（`sessionStore.listSessions()`：置顶优先 → `updatedAt` 倒序）。
 */
async function connect(list: SessionSummaryDTO[]): Promise<void> {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 3000 })
  const base = createMockHostDataSource()
  const source: MockHostDataSource = {
    ...base,
    // 电脑侧的顺序照抄不动（手机端不该在这里重排；这里只是把「真机那份顺序」搬到测试里）
    listSessions: async () => list.map((s) => ({ ...s })),
  }
  const reg = registerHostHandlers(ep, source, { deviceName: 'Virlen 电脑（演示）' })
  base.bind(reg.emit)
  host = { hostT, mobileT, ep, reg, mock: base }
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

/** 顶栏标题 = 手机上「现在打开的哪一个」最直观的那个信号。 */
const openedTitle = (): string | null | undefined =>
  container?.querySelector('.chat__title')?.textContent

/** 等挂载 effect（`loadSessions` → 打开默认会话）落定。 */
async function settle(): Promise<void> {
  await act(async () => {
    await flush(30)
  })
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
  linkStore.detach()
  if (host) {
    host.reg.dispose()
    host.ep.dispose()
    host.hostT.close()
    host.mobileT.close()
    host = null
  }
  vi.restoreAllMocks()
  await flush(0)
})

/* ───────────────────────── 纯函数：选哪一个会话 ───────────────────────── */

describe('pickEntrySession —— 进入时的选择口径', () => {
  it('一个会话都没有 → 什么都不打开（保持「新对话」）', () => {
    expect(pickEntrySession([])).toBeUndefined()
  })

  it('没有会话在工作 → 取 `updatedAt` 最大的那个', () => {
    const list = [
      session(OLD, OLD_TITLE, 1_000),
      session(RECENT, RECENT_TITLE, 9_000),
    ]
    expect(pickEntrySession(list)?.id).toBe(RECENT)
  })

  it('置顶但更旧的会话排在最前 → 仍然不选它（这就是那个缺陷）', () => {
    // 电脑侧的顺序：置顶优先 → updatedAt 倒序
    const list = [
      session(OLD, OLD_TITLE, 1_000, { pinned: true }),
      session(RECENT, RECENT_TITLE, 9_000),
    ]
    expect(pickEntrySession(list)?.id).toBe(RECENT)
  })

  it('有会话在工作 → 打开它，哪怕它更旧', () => {
    const list = [
      session(RECENT, RECENT_TITLE, 9_000),
      session(OLD, OLD_TITLE, 1_000, { working: true }),
    ]
    expect(pickEntrySession(list)?.id).toBe(OLD)
  })

  it('多个会话都在工作 → 取其中最近更新的那个', () => {
    const list = [
      session('a', 'A', 5_000, { working: true }),
      session('b', 'B', 8_000, { working: true }),
      session('c', 'C', 9_000),
    ]
    expect(pickEntrySession(list)?.id).toBe('b')
  })

  it('`working` 缺失 / 为 `false` 都算不在工作', () => {
    const list: SessionSummaryDTO[] = [
      { id: 'a', title: 'A', updatedAt: 5_000 },
      session('b', 'B', 8_000, { working: false }),
    ]
    expect(pickEntrySession(list)?.id).toBe('b')
  })

  it('时间并列 → 保持列表里靠前的那个（兜底不引入第二套排序）', () => {
    const list = [session('a', 'A', 7_000), session('b', 'B', 7_000)]
    expect(pickEntrySession(list)?.id).toBe('a')
  })

  /**
   * 防修过头：这条改动**不是**「不许打开置顶会话」——
   * 置顶那个正好最近（或正在工作）时，它仍然是正确的入口。
   */
  it('置顶的那个正好最近 → 还是它', () => {
    const list = [
      session(RECENT, RECENT_TITLE, 9_000, { pinned: true }),
      session(OLD, OLD_TITLE, 1_000),
    ]
    expect(pickEntrySession(list)?.id).toBe(RECENT)
  })
})

/* ───────────────────────── 接线：真的打开了那一个 ───────────────────────── */

describe('进入后默认打开的会话 —— 真实链路', () => {
  it('置顶的老会话排第一 → 打开的是最近更新的那个', async () => {
    await connect([
      session(OLD, OLD_TITLE, 1_000, { pinned: true }),
      session(RECENT, RECENT_TITLE, 9_000),
    ])
    mount()

    await waitFor(() => chatStore.getSnapshot().currentSessionId === RECENT)
    await settle()
    expect(openedTitle()).toBe(RECENT_TITLE)
    // 真的拉到了它的消息（不是只把 id 写进 state）
    expect(chatStore.getSnapshot().messages[RECENT]).toHaveLength(2)
  })

  it('有会话在工作 → 打开它，哪怕另一个更新更近', async () => {
    await connect([
      session(OLD, OLD_TITLE, 9_000, { pinned: true }),
      session(RECENT, RECENT_TITLE, 1_000, { working: true }),
    ])
    mount()

    await waitFor(() => chatStore.getSnapshot().currentSessionId === RECENT)
    await settle()
    expect(openedTitle()).toBe(RECENT_TITLE)
  })

  it('挂载时已经有当前会话（链路抖动后重新挂载）→ 不抢走用户正看的那个', async () => {
    await connect([
      session(OLD, OLD_TITLE, 1_000, { pinned: true }),
      session(RECENT, RECENT_TITLE, 9_000, { working: true }),
    ])
    // 用户之前就在看这条更旧的会话
    await chatStore.openSession(OLD)
    mount()

    await settle()
    expect(chatStore.getSnapshot().currentSessionId).toBe(OLD)
    expect(openedTitle()).toBe(OLD_TITLE)
  })

  it('电脑上一条会话都没有 → 停在「新对话」', async () => {
    await connect([])
    mount()

    await settle()
    expect(chatStore.getSnapshot().currentSessionId).toBeNull()
    expect(openedTitle()).toBe('新对话')
  })
})
