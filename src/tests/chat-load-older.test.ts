/**
 * 「加载更早的消息」的接线用例（§34 复盘）：**续页不得把视图甩到底部**。
 *
 * 为什么必须挂真实组件：这条契约的落点是**滚动意图** ——
 * 「用户点了加载更早 = 他在看历史」→ 跟随要被取消（`.chat__to-bottom` 出现，
 * 之后的追加 / 再前插都不再落底）。纯函数层只能钉「尾部签名对前插不变」
 * （见 `message-rows.test.ts`）；「谁去取消跟随」只有在 DOM 里可观测。
 *
 * ## ⚠️ 覆盖边界（别把这条用例读大了）
 *
 * 真正的「前插后视口不跳 / 不落底」在 V6 里是**架构层面免费**的：数据倒序 + 容器 `scaleY(-1)`，
 * 「加载历史」= 往数组尾部追加 → 已有元素偏移不变（见 `MessageList.tsx` 文件头）。
 * 本环境（jsdom）里 V6 也是全量渲染（不虚拟化），所以这里能观测到完整行序。
 * 跟随状态由贴底控制器（`inverted/stick.ts`）统一管理，「续页取消跟随」两边都覆盖得到；
 * 滚动本身只能真机核对。
 *
 * 分页靠 mock 的 `demoMessageCount`（默认 2 条，永远翻不出「更早的消息」）——
 * 一页 50 条，120 条正好是「两页半」：够验证「翻到底后按钮消失」。
 *
 * 最后一条用例是 2026-11 真机缺陷的回归位（控制台报 `Encountered two children with the
 * same key`）：
 * 电脑侧那一页**自带重复 id** 时，本机必须归一化 —— 重复 key 会让 React 报
 * `Encountered two children with the same key`，也会让折叠态张冠李戴，不是「多一个气泡」那么轻。
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
/** 预置消息条数：**必须多于一页**（50），否则永远没有「更早的消息」。 */
const DEMO_COUNT = 120

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
  const mock = createMockHostDataSource({ demoMessageCount: DEMO_COUNT, streamDelayMs: 15 })
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

const text = (): string => container?.textContent ?? ''

/** 顶部那条续页按钮（没有更早的消息时它就不该在）。 */
const loadOlderButton = (): HTMLElement | null =>
  container?.querySelector<HTMLElement>('.chat__load-older') ?? null

/** 「回到底部」按钮 —— 它在 = 跟随已取消。 */
const toBottomButton = (): HTMLElement | null =>
  container?.querySelector<HTMLElement>('.chat__to-bottom') ?? null

beforeEach(async () => {
  chatStore.reset()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
  await connect()
  await chatStore.openSession(SESSION)
  // 首页 = 最后 50 条（m70…m119）；更早的两页还没来
  await waitFor(() => (chatStore.getSnapshot().messages[SESSION] ?? []).length > 0)
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

describe('续页：加载更早的消息不得甩到底部', () => {
  it('点「加载更早的消息」→ 更早的一页进来，且**跟随被取消**（出现「回到底部」）', async () => {
    mount()
    await act(async () => {
      await flush(30)
    })

    // 一上来是跟随状态（用户在最新一屏）→ 没有「回到底部」
    expect(toBottomButton()).toBeNull()
    // 首页只有最后 50 条：第 20 条（m20）还在下一页里
    expect(text()).not.toContain('演示消息 #20')

    const button = loadOlderButton()
    expect(button).not.toBeNull()
    click(button!)
    await waitFor(() => text().includes('演示消息 #20'))

    // 「要更早的消息」= 在看历史 → 跟随必须取消（否则下一次前插 / 追加会把视图甩到底部）
    expect(toBottomButton()).not.toBeNull()
  })

  it('点「回到底部」→ 跟随恢复（按钮消失）', async () => {
    mount()
    await act(async () => {
      await flush(30)
    })

    click(loadOlderButton()!)
    await waitFor(() => text().includes('演示消息 #20'))
    const back = toBottomButton()
    expect(back).not.toBeNull()

    click(back!)
    expect(toBottomButton()).toBeNull()
  })

  it('翻到底：按钮自己消失（不再有更早的消息）', async () => {
    mount()
    await act(async () => {
      await flush(30)
    })

    // 120 条 = 首页 50 + 两页更早（50 + 20）
    click(loadOlderButton()!)
    await waitFor(() => text().includes('演示消息 #20'))
    click(loadOlderButton()!)
    await waitFor(() => text().includes('演示消息 #0'))

    expect(loadOlderButton()).toBeNull()
  })

  it('电脑侧那一页**自带重复 id** 时：本机去重（消息不重、React 的 key 唯一）', async () => {
    /*
     * 真机上这一页为什么可能重复：电脑侧 `loadOlderMessagesInner` 的前插
     * （`[...page.messages, ...既有窗口]`）没有按 id 去重 —— 游标一旦重叠（并发 / 流式定稿
     * 插在中间），**它自己的窗口里就是两份**，而手机端的快照 / 续页应答都从那里切。
     *
     * 手机端本地那两条写入通道都按 id 判过重（见 `message-order.test.ts`），所以这里手工
     * 把「服务端页自带重复」造出来 —— 这是唯一进得来的那条路，也是本用例的可回归点。
     */
    const mock = host!.mock
    const original = mock.getMessages.bind(mock)
    mock.getMessages = async (params) => {
      const page = await original(params)
      if (params.fromRowid == null) return page
      // 本页最头两条又被摆了一遍（窗口重叠的等价物）
      return { ...page, messages: [...page.messages.slice(0, 2), ...page.messages] }
    }

    mount()
    await act(async () => {
      await flush(30)
    })

    click(loadOlderButton()!)
    await waitFor(() => text().includes('演示消息 #20'))

    const list = chatStore.getSnapshot().messages[SESSION] ?? []
    const ids = list.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length) // store 里一条重复都没有
    // 屏幕上也只有一条（V6 全量渲染，所以这个计数就是真数）
    expect(text().match(/演示消息 #20/g) ?? []).toHaveLength(1)
  })
})
