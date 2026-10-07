/**
 * 消息窗口**两阶段加载**（§38）—— 先拉摘要立刻出内容，再后台补细节。
 *
 * 为什么必须挂真实链路（memory transport + 共享包 mock 宿主）：
 * 这里要观测的正是**两次 RPC 的时序**（先 `detail:'summary'` 后 full）与「摘要态消息带
 * `deferred`、补完就消失」这两件事 —— 纯函数测不到，只有接上电脑侧的真实应答才看得到。
 *
 * 数据来源：演示会话里那条 `list_files` 工具消息（`demoToolMessage`）—— 它有输出正文，
 * 正是被摘要阶段省掉的东西。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  createMemoryPair,
  registerHostHandlers,
  type HostRegistration,
  type MemoryTransport,
  type MsgPageParams,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource } from 'virlen-remote/testing'
import { chatStore } from '../store/chat'
import { connectionStore } from '../store/connection'
import { devicesStore } from '../store/devices'

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

/** 工具消息（演示会话那条 `list_files`）。 */
function toolMessage() {
  return (chatStore.getSnapshot().messages[SESSION] ?? []).find((m) => m.role === 'tool')
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

describe('两阶段加载（§38）', () => {
  it('先拉摘要（工具消息带 deferred）→ 后台补 full → 重字段补齐', async () => {
    await connect()

    const original = host!.mock.getMessages.bind(host!.mock)
    const seenDetail: Array<string | undefined> = []
    let releaseFull: (() => void) | null = null
    host!.mock.getMessages = async (params: MsgPageParams) => {
      seenDetail.push(params.detail)
      const page = await original(params)
      // 第二阶段（full）卡住，让测试能先观测「摘要态」
      if (params.detail !== 'summary') {
        await new Promise<void>((resolve) => {
          releaseFull = resolve
        })
      }
      return page
    }

    await chatStore.openSession(SESSION)

    // 第一阶段：摘要窗口已渲染，工具消息的正文被省掉、打了 deferred
    const tool = toolMessage()
    expect(tool, '演示会话应有工具消息').toBeTruthy()
    expect(tool!.deferred).toBe(true)
    expect(tool!.text).toBe('')
    expect(tool!.toolArgsFull).toBeUndefined()
    // 工具名 / 入参摘要 / 行数这类「摘要信息」不受影响
    expect(tool!.toolName).toBe('list_files')
    // 第二阶段在途
    expect(chatStore.getSnapshot().detailsLoading[SESSION]).toBe(true)
    // 第一次请求带 `detail:'summary'`，第二次（full）不带
    expect(seenDetail[0]).toBe('summary')
    expect(seenDetail[1]).toBeUndefined()

    // 放行第二阶段 → 重字段补齐、deferred 消失
    releaseFull!()
    await waitFor(() => toolMessage()?.deferred !== true)
    const filled = toolMessage()!
    expect(filled.text).toContain('src/index.ts')
    expect(filled.toolArgsFull).toContain('"path": "src"')
    await waitFor(() => chatStore.getSnapshot().detailsLoading[SESSION] === false)
  })

  it('老电脑端（未声明能力）→ 不退化为两阶段：只发一次、且不带 detail、消息不 deferred', async () => {
    await connect()
    // 模拟旧电脑端：本端看不到 `session.messages.detail` 能力
    chatStore.setCapabilities([])

    const original = host!.mock.getMessages.bind(host!.mock)
    const seenDetail: Array<string | undefined> = []
    host!.mock.getMessages = async (params: MsgPageParams) => {
      seenDetail.push(params.detail)
      return original(params)
    }

    await chatStore.openSession(SESSION)
    await waitFor(() => (chatStore.getSnapshot().messages[SESSION] ?? []).length === 4)

    // 只发一次，不带 detail → 工具消息直接带完整正文
    expect(seenDetail).toEqual([undefined])
    const tool = toolMessage()!
    expect(tool.deferred).toBeUndefined()
    expect(tool.text).toContain('src/index.ts')
  })
})
