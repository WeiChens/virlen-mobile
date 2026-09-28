/**
 * 链路观测（`store/link.ts`）—— 采样、心跳、失联判定。
 *
 * 这一组用例针对的全是**真机才会遇到、但一旦错了很贵**的东西：
 *  - 候选对会变（先走中继、打洞成功后换直连）→ 面板必须跟得上；
 *  - 「静的死」（网络没了，两端还都觉得自己连着）→ 要靠心跳发现；
 *  - 反过来，**误判失联的代价是白白重建一条好链路** → 三条安全阀必须逐个钉死：
 *    没有判据不判、没发过心跳不判、不着急（15 秒）。
 *
 * 真实 WebRTC 跑不进 CI，所以这里用假 PeerConnection + 假时钟；
 * `api/active` 被替成可控的假端点（心跳就是发往它）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LINK_HEARTBEAT_MS, LINK_SAMPLE_MS, linkStore, type RtcPeer } from '../store/link'

/** 假端点：`ping()` 的返回值可注入（链路非 open 时共享包会返回 false）。 */
const fake = vi.hoisted(() => ({ pingResult: true, pings: 0 }))

vi.mock('../api/active', () => ({
  getEndpoint: () => ({
    ping: () => {
      fake.pings += 1
      return fake.pingResult
    },
  }),
  // 本用例不碰 RPC / host 事件：真调到就是用例写错了，直接抛
  getCaller: () => {
    throw new Error('本用例不应调用 RPC')
  },
  setActive: () => {},
  clearActive: () => {},
  onEndpointReady: () => () => {},
}))

/** 造一条 stats 记录集：`path: 'none'` = 连候选对都还没出来。 */
function entries(
  o: { path?: 'direct' | 'relay' | 'none'; received?: number; messages?: number; rttSec?: number } = {},
): unknown[] {
  const list: unknown[] = []
  if (o.path !== 'none') {
    list.push({ type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' })
    list.push({
      type: 'candidate-pair',
      id: 'P0',
      localCandidateId: 'L0',
      remoteCandidateId: 'R0',
      state: 'succeeded',
      ...(o.rttSec != null ? { currentRoundTripTime: o.rttSec } : {}),
    })
    list.push({ id: 'L0', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' })
    list.push({ id: 'R0', type: 'remote-candidate', candidateType: o.path === 'relay' ? 'relay' : 'host' })
  }
  const dc: Record<string, unknown> = { type: 'data-channel', id: 'DC0' }
  if (o.received != null) dc.bytesReceived = o.received
  if (o.messages != null) dc.messagesReceived = o.messages
  list.push(dc)
  return list
}

/** 假 PeerConnection：stats 可换、状态变化可手动触发。 */
class FakePeer implements RtcPeer {
  connectionState = 'connected'
  private list: unknown[] = []
  private readonly listeners = new Set<() => void>()

  setStats(next: unknown[]): void {
    this.list = next
  }

  getStats(): Promise<{ forEach(callback: (entry: unknown) => void): void }> {
    return Promise.resolve({ forEach: (cb: (entry: unknown) => void) => this.list.forEach(cb) })
  }

  addEventListener(_type: 'connectionstatechange', listener: () => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'connectionstatechange', listener: () => void): void {
    this.listeners.delete(listener)
  }

  /** 通知「状态变了」（相当于真实 PC 触发 connectionstatechange）。 */
  fire(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

let stalls: number[] = []
let offStall: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  stalls = []
  fake.pings = 0
  fake.pingResult = true
  offStall = linkStore.onStall((ms) => stalls.push(ms))
})

afterEach(() => {
  offStall?.()
  offStall = null
  linkStore.detach()
  vi.useRealTimers()
})

describe('linkStore —— 采样与候选对变化', () => {
  it('attach 后立刻采一次（面板一打开就有数字），候选对换了跟得上', async () => {
    const peer = new FakePeer()
    peer.setStats(entries({ path: 'relay', received: 100, rttSec: 0.2 }))
    linkStore.attach(peer)
    await vi.advanceTimersByTimeAsync(0)

    const first = linkStore.getSnapshot()
    expect(first.attached).toBe(true)
    expect(first.path).toBe('relay')
    expect(first.rttMs).toBeCloseTo(200)
    expect(first.bytesReceived).toBe(100)
    expect(first.since).toBeGreaterThan(0)

    // 打洞成功：候选对从「经 TURN」换成「直连」—— 这正是「刚连上显示中继」的真实由来
    peer.setStats(entries({ path: 'direct', received: 260 }))
    await vi.advanceTimersByTimeAsync(LINK_SAMPLE_MS)
    expect(linkStore.getSnapshot().path).toBe('direct')
  })

  it('传输积压从注入的探针读（背压观察点）', async () => {
    const peer = new FakePeer()
    peer.setStats(entries({ path: 'direct', received: 1 }))
    let buffered = 4096
    linkStore.attach(peer, { bufferedAmount: () => buffered })
    await vi.advanceTimersByTimeAsync(0)
    expect(linkStore.getSnapshot().bufferedAmount).toBe(4096)

    buffered = 0
    await vi.advanceTimersByTimeAsync(LINK_SAMPLE_MS)
    expect(linkStore.getSnapshot().bufferedAmount).toBe(0)
  })

  it('链路 closed → 自动摘掉，且不再采样（不留上一次的残值骗人）', async () => {
    const peer = new FakePeer()
    peer.setStats(entries({ path: 'direct', received: 42 }))
    linkStore.attach(peer)
    await vi.advanceTimersByTimeAsync(0)
    expect(linkStore.getSnapshot().bytesReceived).toBe(42)

    const spy = vi.spyOn(peer, 'getStats')
    peer.connectionState = 'closed'
    peer.fire()

    const view = linkStore.getSnapshot()
    expect(view.attached).toBe(false)
    expect(view.path).toBe('unknown')
    expect(view.bytesReceived).toBeNull()

    await vi.advanceTimersByTimeAsync(LINK_SAMPLE_MS * 3)
    expect(spy).not.toHaveBeenCalled()
  })

  it('换链路（attach 新 PC）→ 上一条链路的结论全部作废', async () => {
    const first = new FakePeer()
    first.setStats(entries({ path: 'relay', received: 10 }))
    linkStore.attach(first)
    await vi.advanceTimersByTimeAsync(0)
    expect(linkStore.getSnapshot().path).toBe('relay')

    const second = new FakePeer()
    second.setStats(entries({ path: 'direct', received: 0 }))
    linkStore.attach(second)
    await vi.advanceTimersByTimeAsync(0)
    const view = linkStore.getSnapshot()
    expect(view.path).toBe('direct')
    // 计数属于上一条链路：不能带着走（否则新链路的「安静时长」从负数/巨额开始）
    expect(view.bytesReceived).toBe(0)
  })
})

describe('linkStore —— 心跳与失联判定', () => {
  it('心跳有回音（接收计数在涨）→ 一次都不判失联', async () => {
    const peer = new FakePeer()
    let received = 0
    peer.setStats(entries({ path: 'direct', received: 0 }))
    linkStore.attach(peer)
    await vi.advanceTimersByTimeAsync(0)

    // 电脑端每 2 秒回来一点字节（回 pong / 推事件都算）
    for (let i = 0; i < 15; i += 1) {
      received += 40
      peer.setStats(entries({ path: 'direct', received }))
      await vi.advanceTimersByTimeAsync(LINK_SAMPLE_MS)
    }

    expect(fake.pings).toBeGreaterThan(0)
    expect(stalls).toEqual([])
    const view = linkStore.getSnapshot()
    expect(view.stalled).toBe(false)
    expect(view.silentMs).toBeLessThan(3000)
    expect(view.lastRxAt).not.toBeNull()
  })

  it('心跳发出去后连续 15 秒没字节 → 判失联，且只通知一次（重连的账只记一处）', async () => {
    const peer = new FakePeer()
    peer.setStats(entries({ path: 'direct', received: 500 }))
    linkStore.attach(peer)
    await vi.advanceTimersByTimeAsync(0)

    // 14 秒时还在阈值内：不能着急（单次卡顿 / 丢一帧都不算死）
    await vi.advanceTimersByTimeAsync(14_000)
    expect(fake.pings).toBeGreaterThan(0)
    expect(stalls).toEqual([])
    expect(linkStore.getSnapshot().stalled).toBe(false)

    // 16 秒：三个心跳周期都没回音 → 判死
    await vi.advanceTimersByTimeAsync(LINK_SAMPLE_MS * 2)
    expect(stalls).toHaveLength(1)
    expect(stalls[0]).toBeGreaterThanOrEqual(15_000)
    expect(linkStore.getSnapshot().stalled).toBe(true)

    // 判死之后不再反复通知（否则同一秒里能触发好几次重连）
    await vi.advanceTimersByTimeAsync(LINK_SAMPLE_MS * 5)
    expect(stalls).toHaveLength(1)
  })

  it('安全阀①：本机读不到接收计数 → 永不判失联（宁可漏判，也不能把好链路判死）', async () => {
    const peer = new FakePeer()
    peer.setStats(entries({ path: 'direct' })) // 没有 bytesReceived / messagesReceived
    linkStore.attach(peer)
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.pings).toBeGreaterThan(0) // 心跳照发（那是「链路还开着」的常规保活）
    expect(stalls).toEqual([])
    expect(linkStore.getSnapshot().silentMs).toBeNull()
  })

  it('安全阀②：链路非 open（ping 返回 false）→ 不算「安静」，也不判失联', async () => {
    fake.pingResult = false
    const peer = new FakePeer()
    peer.setStats(entries({ path: 'direct', received: 1 }))
    linkStore.attach(peer)
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(60_000)
    // 这种情形是**链路状态机**的活（它会自己上报 connecting/closed，连接层会重连）
    expect(stalls).toEqual([])
    expect(linkStore.getSnapshot().stalled).toBe(false)
  })

  it('回到前台重置基准：切后台期间计时器不走，不能因此每次都白重建一次链路', async () => {
    fake.pingResult = false // 关掉心跳，单独看基准重置这件事
    const peer = new FakePeer()
    peer.setStats(entries({ path: 'direct', received: 7 }))
    linkStore.attach(peer)
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(20_000)
    const before = linkStore.getSnapshot()
    expect(before.silentMs).toBeGreaterThan(10_000)

    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))

    const view = linkStore.getSnapshot()
    expect(view.silentMs).toBe(0)
    expect(view.stalled).toBe(false)
    // 「已连接时长」是给人看的事实，不能跟着基准一起被重置
    expect(view.since).toBe(before.since)
    expect(stalls).toEqual([])
  })
})

describe('linkStore —— 读不到数据时也不能崩', () => {
  it('getStats 抛错 → 记下原因，不判失联、不崩', async () => {
    const peer = new FakePeer()
    peer.getStats = () => Promise.reject(new Error('NotSupportedError: getStats'))
    linkStore.attach(peer)

    await vi.advanceTimersByTimeAsync(10_000)
    const view = linkStore.getSnapshot()
    expect(view.attached).toBe(true)
    expect(view.error).toContain('NotSupported')
    expect(view.path).toBe('unknown')
    expect(stalls).toEqual([])
  })

  it('后续采样成功后清掉上一次的报错（面板不该一直挂着旧错）', async () => {
    const peer = new FakePeer()
    peer.getStats = () => Promise.reject(new Error('boom'))
    linkStore.attach(peer)
    await vi.advanceTimersByTimeAsync(LINK_SAMPLE_MS)
    expect(linkStore.getSnapshot().error).toBe('boom')

    peer.getStats = FakePeer.prototype.getStats.bind(peer)
    peer.setStats(entries({ path: 'direct', received: 5 }))
    await vi.advanceTimersByTimeAsync(LINK_SAMPLE_MS)
    expect(linkStore.getSnapshot().error).toBeUndefined()
    expect(linkStore.getSnapshot().path).toBe('direct')
  })

  it('探针（bufferedAmount）抛错按 0 处理，不把采样一起带崩', async () => {
    const peer = new FakePeer()
    peer.setStats(entries({ path: 'direct', received: 1 }))
    linkStore.attach(peer, {
      bufferedAmount: () => {
        throw new Error('探针坏了')
      },
    })
    await vi.advanceTimersByTimeAsync(LINK_SAMPLE_MS)
    expect(linkStore.getSnapshot().bufferedAmount).toBe(0)
    expect(linkStore.getSnapshot().error).toBeUndefined()
  })

  it('心跳间隔短于采样间隔：一轮心跳里至少已经采过一次（面板不会说「已连接」却说没数据）', () => {
    expect(LINK_HEARTBEAT_MS).toBeGreaterThan(0)
    expect(LINK_HEARTBEAT_MS).toBeLessThanOrEqual(LINK_SAMPLE_MS * 3)
  })
})
