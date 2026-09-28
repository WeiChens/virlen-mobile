/**
 * 掉线后的重连与「放弃」（`store/connection.ts`）。
 *
 * 用户口径（M10）：**信号中断后重连 3 次，还不行就退回登录页**。
 * 这一组用例钉三件事：
 *  1. 短路（`connecting`）不再无限等 —— 8 秒宽限到点就按断线处理
 *     （浏览器可能再也不给事件，旧行为会一直停在「正在尝试恢复…」而其实什么都没做）；
 *  2. 重连**恰好 3 次**，用尽即退回登录页（`error:'dropped'`），之后不再偷偷尝试；
 *  3. 退回登录页**不删配对凭证** —— 用户在登录页点「连接」就能重来，不必重新扫码。
 *
 * `api/transport` 被替成「按顺序发链路」的假工厂：这样「第一次成功、后面三次沉默」
 * 这种剧本才能在 CI 里复现（真信令 + 真打洞跑不进来）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
  MemoryTransport,
  createMemoryPair,
  registerHostHandlers,
  type Transport,
  type TransportState,
} from 'virlen-remote'
import { createMockHostDataSource } from 'virlen-remote/testing'
import { connectionStore } from '../store/connection'
import { devicesStore } from '../store/devices'
import { linkStore } from '../store/link'

/** 假工厂的状态（`vi.mock` 会被提升，所以要用 `vi.hoisted` 先建好它）。 */
const harness = vi.hoisted(() => ({
  /** 备好的链路（按顺序取；取完了就返回「沉默链路」）。 */
  queue: [] as unknown[],
  /** 一共建了几条链路 —— 用来断言「放弃之后不再偷偷尝试」。 */
  created: 0,
}))

vi.mock('../api/transport', async () => {
  const { MemoryTransport: Memory } = await import('virlen-remote')
  return {
    channelNameFor: (hostId: string) => `virlen-remote:${hostId}`,
    createTransport: () => {
      harness.created += 1
      const queued = harness.queue.shift()
      if (queued) return queued
      // 沉默链路：链路本身是通的（`open`），但**没人应答 hello** ——
      // 正是「电脑端没在听 / 网络已经断了」在手机端的表现
      const silent = new Memory()
      silent.open()
      return silent
    },
  }
})

/** 一条「手机端会主动去连」的假链路（`connecting` 这一档只有我们自己能造）。 */
class StateSpy implements Transport {
  private readonly listeners = new Set<(state: TransportState) => void>()

  constructor(private readonly inner: Transport) {}

  get state(): TransportState {
    return this.inner.state
  }
  get bufferedAmount(): number {
    return this.inner.bufferedAmount
  }
  send(bytes: Uint8Array): void {
    this.inner.send(bytes)
  }
  close(): void {
    this.inner.close()
  }
  onMessage(listener: (bytes: Uint8Array) => void): () => void {
    return this.inner.onMessage(listener)
  }
  onStateChange(listener: (state: TransportState) => void): () => void {
    this.listeners.add(listener)
    const offInner = this.inner.onStateChange(listener)
    return () => {
      this.listeners.delete(listener)
      offInner()
    }
  }
  whenReady(): Promise<void> {
    return this.inner.whenReady?.() ?? Promise.resolve()
  }
  start(): void {
    this.inner.start?.()
  }

  /** 手动上报一个链路状态（`connecting` = `disconnected` 的映射）。 */
  emit(state: TransportState): void {
    for (const listener of [...this.listeners]) listener(state)
  }
}

/** 一条空链路（没人应答）—— 每次要用时现造，避免被重复消费。 */
function silentTransport(): MemoryTransport {
  const t = new MemoryTransport()
  t.open()
  return t
}

interface HostHarness {
  hostT: MemoryTransport
  mobileT: MemoryTransport
  ep: Endpoint
  reg: ReturnType<typeof registerHostHandlers>
}

let hosts: HostHarness[] = []

/** 一套「真电脑端」：会正常应答 hello（走共享包的 mock 宿主）。 */
function setupHost(): HostHarness {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mock = createMockHostDataSource({ streamSteps: 2, streamDelayMs: 5 })
  const reg = registerHostHandlers(ep, mock, { deviceName: 'Virlen 电脑（演示）' })
  mock.bind(reg.emit)
  const harnessHost: HostHarness = { hostT, mobileT, ep, reg }
  hosts.push(harnessHost)
  return harnessHost
}

/** 收集重连进度序列（用来断言「刚好 3 次」，而不是凭感觉）。 */
function watchAttempts(): { seen: number[]; off: () => void } {
  const seen: number[] = []
  const off = connectionStore.subscribe(() => {
    const attempt = connectionStore.getSnapshot().reconnecting?.attempt
    if (attempt != null && seen[seen.length - 1] !== attempt) seen.push(attempt)
  })
  return { seen, off }
}

/** 按 1 秒一步推进假时钟（一次跳一大段会让「链在链条上的定时器」难以推理）。 */
async function advance(ms: number): Promise<void> {
  const steps = Math.ceil(ms / 1000)
  for (let i = 0; i < steps; i += 1) await vi.advanceTimersByTimeAsync(1000)
}

/** 建立一条真链路（第一次连接走 mock 宿主）。 */
async function connectGood(): Promise<HostHarness> {
  const host = setupHost()
  harness.queue.push(host.mobileT)
  const ok = await connectionStore.connect({ hostId: 'dk-demo', deviceName: '演示电脑', token: 'gt-demo' })
  expect(ok).toBe(true)
  return host
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  harness.queue = []
  harness.created = 0
  connectionStore.disconnect()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
})

afterEach(() => {
  connectionStore.disconnect()
  linkStore.detach()
  vi.useRealTimers()
  for (const host of hosts) {
    host.reg.dispose()
    host.ep.dispose()
    host.hostT.close()
    host.mobileT.close()
  }
  hosts = []
})

describe('链路重连与放弃', () => {
  it('掉线 → 重连恰好 3 次都失败 → 退回登录页，之后不再偷偷尝试（配对凭证保留）', async () => {
    const host = await connectGood()
    const { seen, off } = watchAttempts()

    host.mobileT.close() // 链路闭死（transport 上报 closed）
    await advance(1000)
    expect(connectionStore.getSnapshot().link).toBe('closed')
    expect(seen).toEqual([1]) // 退避 2 秒后才动手，但「正在重连第 1 次」当场就要告诉用户

    // 三次尝试各要一次 hello 超时（4 秒）+ 退避（2 / 5 / 10 秒）
    await advance(60_000)
    const state = connectionStore.getSnapshot()
    expect(seen).toEqual([1, 2, 3])
    expect(state.status).toBe('error')
    expect(state.error?.reason).toBe('dropped')
    expect(state.error?.message).toContain('重连 3 次')
    expect(state.reconnecting).toBeUndefined()
    expect(state.link).toBe('closed')

    // 放弃 = 真的放弃：不再建链路（否则用户停在登录页也会被反复打扰）
    const createdAtGiveUp = harness.created
    await advance(60_000)
    expect(harness.created).toBe(createdAtGiveUp)

    // 但凭证还在手机里：回登录页点「连接」即可，不必重新扫码
    const devices = devicesStore.getSnapshot()
    expect(devices).toHaveLength(1)
    expect(devices[0].grant).toBe('gt-demo')
    off()
  })

  it('第 3 次重连成功 → 回到 online（没到上限绝不放弃）', async () => {
    const host = await connectGood()
    const { seen, off } = watchAttempts()
    const third = setupHost()
    // 第 1、2 次沉默，第 3 次给一条真链路
    harness.queue.push(silentTransport(), silentTransport(), third.mobileT)

    host.mobileT.close()
    await advance(60_000)

    expect(seen).toEqual([1, 2, 3])
    const state = connectionStore.getSnapshot()
    expect(state.status).toBe('online')
    expect(state.link).toBe('open')
    expect(state.error).toBeUndefined()
    expect(state.reconnecting).toBeUndefined()
    off()
  })

  it('短路（connecting）先给 8 秒宽限，到点仍没恢复才按断线重连', async () => {
    const host = setupHost()
    const spy = new StateSpy(host.mobileT)
    harness.queue.push(spy)
    const ok = await connectionStore.connect({ hostId: 'dk-demo', deviceName: '演示电脑', token: 'gt-demo' })
    expect(ok).toBe(true)

    const { seen, off } = watchAttempts()
    // ⚠️ 这是`disconnected`的映射：链路还没「闭死」，但浏览器可能再也不给事件
    spy.emit('connecting')
    expect(connectionStore.getSnapshot().link).toBe('connecting')

    await advance(7000)
    expect(seen).toEqual([]) // 宽限期内不动手：它常常自己会好（换网 / ICE 重新提名）

    await advance(2000)
    expect(seen).toEqual([1])
    expect(connectionStore.getSnapshot().link).toBe('closed')
    off()
  })

  it('短路后又恢复（宽限期内回到 open）→ 不重连、也没有错误', async () => {
    const host = setupHost()
    const spy = new StateSpy(host.mobileT)
    harness.queue.push(spy)
    await connectionStore.connect({ hostId: 'dk-demo', deviceName: '演示电脑', token: 'gt-demo' })

    const { seen, off } = watchAttempts()
    spy.emit('connecting')
    await advance(3000)
    spy.emit('open') // 抖动结束
    await advance(20_000)

    const state = connectionStore.getSnapshot()
    expect(seen).toEqual([])
    expect(state.link).toBe('open')
    expect(state.status).toBe('online')
    expect(state.error).toBeUndefined()
    off()
  })

  it('掉线后链路自己回来 → 重连计数清零（下一轮从头数 3 次）', async () => {
    const host = await connectGood()
    host.mobileT.close()
    await advance(1000)
    expect(connectionStore.getSnapshot().reconnecting?.attempt).toBe(1)

    host.mobileT.reconnect() // 链路恢复（`open`）
    await advance(1000)
    const state = connectionStore.getSnapshot()
    expect(state.link).toBe('open')
    expect(state.reconnecting).toBeUndefined()

    // 再掉一次：应当又是第 1 次，而不是接着数到第 2 次
    const { seen, off } = watchAttempts()
    host.mobileT.close()
    await advance(1000)
    expect(seen).toEqual([1])
    off()
  })
})

describe('链路观测与连接层的分工', () => {
  it('注入链路（非 RTC）不挂链路观测：面板据此说明「本次不是 WebRTC」', () => {
    expect(linkStore.getSnapshot().attached).toBe(false)
  })
})
