/**
 * §33 传输档位在「通讯状态面板」上的显示 —— 两个事实必须同时正确：
 *
 *  1. 档位跟着**本机判定的链路类型**走（直连 → 完整；中继 / 类型未判定 → 精简）；
 *  2. 但「是否真的在精简」还看**电脑端支不支持**（`hello` 应答的能力集里有 `message.detail`）——
 *     电脑端太旧时必须说「不支持、照常全量下发」，而不是摆一个「精简」让用户以为输出被省了
 *     （反之亦然：面板说精简、实际一个字节没省，是同一个谎）。
 *
 * 为什么值得挂真实组件：这一层全是「读不到就说不知道」的字段，出错的方式不是抛异常而是
 * **显示一句不成立的话**。这里把三种组合都渲染出来看一眼（与 `link-ui.test.ts` 同一破例）。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Endpoint,
  MESSAGE_DETAIL_CAPABILITY,
  createMemoryPair,
  registerHostHandlers,
  type HostRegistration,
  type MemoryTransport,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource } from 'virlen-remote/testing'
import LinkSheet from '../ui/components/LinkSheet'
import { chatStore } from '../store/chat'
import { connectionStore } from '../store/connection'
import { devicesStore } from '../store/devices'
import { linkStore, type RtcPeer } from '../store/link'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 假 PeerConnection：只喂 stats（与 `link-ui.test.ts` 同形）。 */
class FakePeer implements RtcPeer {
  readonly connectionState = 'connected'
  constructor(private readonly list: unknown[]) {}

  getStats(): Promise<{ forEach(callback: (entry: unknown) => void): void }> {
    return Promise.resolve({ forEach: (cb: (entry: unknown) => void) => this.list.forEach(cb) })
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

function statsPair(localType: string, remoteType: string) {
  return [
    { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
    {
      type: 'candidate-pair',
      id: 'P0',
      localCandidateId: 'L0',
      remoteCandidateId: 'R0',
      state: 'succeeded',
      currentRoundTripTime: 0.02,
    },
    { id: 'L0', type: 'local-candidate', candidateType: localType, protocol: 'udp' },
    { id: 'R0', type: 'remote-candidate', candidateType: remoteType },
  ]
}

/** 经 TURN 中继（本端 host ↔ 对端 relay）→ 档位应为精简。 */
const RELAY_STATS = statsPair('host', 'relay')
/** 打洞成功（srflx）→ 直连 → 档位应为完整。 */
const DIRECT_STATS = statsPair('srflx', 'srflx')

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
 * 接一台「电脑」：`hostCapabilities` 就是它 `hello` 应答里报的能力集
 * （mock 自己实现了 `hello`，这里覆写它的应答才能控制这一项 ——
 * 它决定手机端能不能说「真的在精简」）。
 */
async function connect(hostCapabilities: string[]): Promise<void> {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mock = createMockHostDataSource({})
  const original = mock.hello
  if (!original) throw new Error('mock 宿主没有实现 hello —— 本用例靠它控制能力集')
  mock.hello = async (params) => ({ ...(await original.call(mock, params)), capabilities: hostCapabilities })
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

function mount(): string {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(LinkSheet, { onClose: () => {} }))
  })
  return container.textContent ?? ''
}

beforeEach(() => {
  chatStore.reset()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
  linkStore.detach()
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
  linkStore.detach()
  connectionStore.disconnect()
  if (host) {
    host.reg.dispose()
    host.ep.dispose()
    host.hostT.close()
    host.mobileT.close()
    host = null
  }
})

describe('LinkSheet —— 传输档位', () => {
  it('中继 + 电脑端支持：显示精简，并说清工具输出不下发、怎么拿回全文', async () => {
    await connect(['session.list', MESSAGE_DETAIL_CAPABILITY])
    linkStore.attach(new FakePeer(RELAY_STATS))
    await act(async () => {
      await flush(10)
    })

    const text = mount()
    expect(text).toContain('传输档位')
    expect(text).toContain('精简（只传主要内容）')
    expect(text).toContain('输出正文不下发')
    expect(text).toContain('重开会话')
  })

  it('直连 + 电脑端支持：显示完整，并明说「不省任何东西」', async () => {
    await connect(['session.list', MESSAGE_DETAIL_CAPABILITY])
    linkStore.attach(new FakePeer(DIRECT_STATS))
    await act(async () => {
      await flush(10)
    })

    const text = mount()
    expect(text).toContain('完整（含工具输出）')
    expect(text).toContain('完整下发')
    expect(text).not.toContain('输出正文不下发')
  })

  it('电脑端不支持档位（旧版）：显示完整并说明原因 —— 不能摆一个「精简」骗人', async () => {
    await connect(['session.list'])
    linkStore.attach(new FakePeer(RELAY_STATS))
    await act(async () => {
      await flush(10)
    })

    const text = mount()
    expect(text).toContain('完整（含工具输出）')
    expect(text).toContain('不支持传输档位')
    expect(text).not.toContain('精简（只传主要内容）')
  })

  it('没连上时不摆档位区（那时档位没有意义，摆出来只是噪音）', () => {
    const text = mount()
    expect(text).not.toContain('传输档位')
  })
})
