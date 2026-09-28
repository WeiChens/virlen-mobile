/**
 * 「链路代际更替后重新授权」（P2）与「硬拒绝回登录页」（P3）。
 *
 * 真机缺陷（移除后手机假在线）：电脑端移除设备会**拆掉并重开**链路；手机端若只看到
 * `connecting → open`（同一次会话里的透明重建），就不会重跑 `connect()`、也就不会重发 `hello` ——
 * 于是旧授权已作废却没人发现，手机显示「在线」，电脑端停在「正在验证」。
 *
 * 这一组钉三件事：
 *  1. `connecting → open` 之后**必须重新握手**（授权是 per-link 的）；
 *  2. 重新握手被硬拒绝（如 `revoked`）→ **退回登录页**，不再假在线；
 *  3. 走「断线重连」路径时被硬拒绝 → 同样退回登录页（不是只把 link 置 closed 却留着 online）。
 *
 * `api/transport` 被替成「按顺序发链路」的假工厂，`host.hello` 用一个可控的宿主实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BridgeError,
  Endpoint,
  MemoryTransport,
  createMemoryPair,
  registerHostHandlers,
  type HelloResult,
  type HostDataSource,
  type Transport,
  type TransportState,
} from 'virlen-remote'
import { connectionStore } from '../store/connection'
import { devicesStore } from '../store/devices'
import { linkStore } from '../store/link'

const harness = vi.hoisted(() => ({ queue: [] as unknown[], created: 0 }))

vi.mock('../api/transport', async () => {
  const { MemoryTransport: Memory } = await import('virlen-remote')
  return {
    channelNameFor: (hostId: string) => `virlen-remote:${hostId}`,
    createTransport: () => {
      harness.created += 1
      const queued = harness.queue.shift()
      if (queued) return queued
      // 沉默链路：链路通但没人应答 hello
      const silent = new Memory()
      silent.open()
      return silent
    },
  }
})

/** 能手动上报链路状态的假链路（造 `connecting` 这一档只有我们能做）。 */
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
    const off = this.inner.onStateChange(listener)
    return () => {
      this.listeners.delete(listener)
      off()
    }
  }
  whenReady(): Promise<void> {
    return this.inner.whenReady?.() ?? Promise.resolve()
  }
  start(): void {
    this.inner.start?.()
  }
  emit(state: TransportState): void {
    for (const listener of [...this.listeners]) listener(state)
  }
}

interface HostHarness {
  hostT: MemoryTransport
  mobileT: MemoryTransport
  ep: Endpoint
  reg: ReturnType<typeof registerHostHandlers>
  hellos: () => number
}

const okHello = (): HelloResult =>
  ({
    protocolVersion: 1,
    host: { platform: 'test', appVersion: '0' },
    capabilities: [],
    paired: true,
    deviceName: '电脑',
    deviceId: 'dk-demo',
  }) as HelloResult

let hosts: HostHarness[] = []

/** 一套可控的电脑端：`helloImpl` 决定每次 `host.hello` 的结论（缺省恒成功）。 */
function setupHost(helloImpl?: () => HelloResult | Promise<HelloResult>): HostHarness {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  let count = 0
  const source = {
    async hello(): Promise<HelloResult> {
      count += 1
      return helloImpl ? helloImpl() : okHello()
    },
  } as unknown as HostDataSource
  const reg = registerHostHandlers(ep, source, { deviceName: '电脑' })
  const h: HostHarness = { hostT, mobileT, ep, reg, hellos: () => count }
  hosts.push(h)
  return h
}

/** 让下一次重连命中一个「拒绝 hello」的电脑端。 */
function denyingHost(reason: 'revoked' | 'expired' = 'revoked'): HostHarness {
  return setupHost(() => {
    throw new BridgeError('E_DENIED', '已移除', { data: { reason } })
  })
}

/** 按 1 秒一步推进假时钟（与 link-recovery 同一口径，便于推理定时器链）。 */
async function advance(ms: number): Promise<void> {
  const steps = Math.ceil(ms / 1000)
  for (let i = 0; i < steps; i += 1) await vi.advanceTimersByTimeAsync(1000)
}

/** 连上 `host`（用 `spy` 包住，便于手动制造链路抖动）。 */
async function connectThrough(spy: Transport): Promise<void> {
  harness.queue.push(spy)
  const ok = await connectionStore.connect({ hostId: 'dk-demo', deviceName: '电脑', token: 'gt-demo' })
  expect(ok).toBe(true)
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

describe('链路代际更替后重新授权（P2）', () => {
  it('connecting → open 会重新握手（旧授权随旧链路作废）', async () => {
    const host = setupHost()
    const spy = new StateSpy(host.mobileT)
    await connectThrough(spy)
    expect(host.hellos()).toBe(1)

    // 对端透明重建链路：本端只看到抖动
    spy.emit('connecting')
    spy.emit('open')
    await advance(1000)

    // 重新握手：这是「电脑端能重新判定授权」的唯一途径
    expect(host.hellos()).toBe(2)
    const s = connectionStore.getSnapshot()
    expect(s.status).toBe('online')
    expect(s.link).toBe('open')
    expect(s.error).toBeUndefined()
  })
})

describe('硬拒绝退回登录页（P3）', () => {
  it('重新握手被拒（revoked）→ 退出在线态、回登录页', async () => {
    let allow = true
    const host = setupHost(() => {
      if (!allow) throw new BridgeError('E_DENIED', '这台手机已被移除', { data: { reason: 'revoked' } })
      return okHello()
    })
    const spy = new StateSpy(host.mobileT)
    await connectThrough(spy)
    expect(connectionStore.getSnapshot().status).toBe('online')

    allow = false
    spy.emit('connecting')
    spy.emit('open')
    await advance(1000)

    const s = connectionStore.getSnapshot()
    expect(s.status).toBe('error')
    expect(s.error?.reason).toBe('revoked')
    expect(s.error?.message).toContain('移除')
    expect(s.reconnecting).toBeUndefined()
    // 不再偷偷重连
    const created = harness.created
    await advance(60_000)
    expect(harness.created).toBe(created)
  })

  it('断线重连时被拒（revoked）→ 不保留「在线」，退回登录页', async () => {
    const host = setupHost()
    const spy = new StateSpy(host.mobileT)
    await connectThrough(spy)
    expect(connectionStore.getSnapshot().status).toBe('online')

    // 下一次重连命中一个拒绝的电脑端
    harness.queue.push(denyingHost().mobileT)
    host.mobileT.close() // 链路闭死 → noteLinkDead → 退避 2 秒后重连
    await advance(4000)

    const s = connectionStore.getSnapshot()
    expect(s.status).toBe('error')
    expect(s.error?.reason).toBe('revoked')
    expect(s.link).toBe('closed')
    expect(s.reconnecting).toBeUndefined()
  })
})
