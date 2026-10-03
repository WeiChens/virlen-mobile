/**
 * 现场配对成功后，**重连必须改用电脑端签发的凭证**（`grant`），不能继续用那张一次性票据。
 *
 * ## 缺陷现场（真机反馈）
 *
 * 手机扫码配对成功 → 过一会儿（链路抖动 / 电脑端重建链路）手机自动重连 →
 * **电脑端显示拒绝、手机端显示「二维码已过期，请重新扫描电脑上的新二维码」**，
 * 而电脑端「已绑定的手机」列表里**还留着这台手机** —— 三件事同时成立，看着互相矛盾。
 *
 * ## 根因
 *
 * `connect()` 成功时把重连参数记成 `{ ...options }` —— 而扫码那条路径的 `options.token`
 * 是**一次性票据**（`pr-…`）。票在配对那一刻就被电脑端消费掉（`redeemTicket` 会删票），
 * 于是之后每一次「重连 / 重新授权」都在用一张**已作废的票**：
 *
 *  1. 电脑端 `pairing.authorize` 查不到这张票、它又以 `pr-` 开头 → `ticket-expired`；
 *  2. 手机端收到 `ticket-expired`（在 `HARD_DENIALS` 里）→ 直接退回登录页并提示重新扫码；
 *  3. 电脑端进 `rejected`（「已拒绝接入（二维码已过期）」）—— 而**配对记录本身是好的**，
 *     所以列表里当然还留着它。
 *
 * 电脑端签发的凭证当次就回传了（`HelloResult.grant`）并已存进设备列表，只是**没有同步进
 * 重连参数** —— 于是「列表里能手动连上（用 grant），自动重连却永远失败（用死票）」。
 *
 * ## 为什么以前没被发现
 *
 * `link-reverify.test.ts` 那一组用例的 token 传的是 `gt-demo`（凭证），恰好绕过了扫码
 * 这条路径；而真机上「扫码配对」才是主流入口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
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

const harness = vi.hoisted(() => ({ queue: [] as unknown[] }))

vi.mock('../api/transport', async () => {
  const { MemoryTransport: Memory } = await import('virlen-remote')
  return {
    channelNameFor: (hostId: string) => `virlen-remote:${hostId}`,
    createTransport: () => {
      const queued = harness.queue.shift()
      if (queued) return queued
      // 沉默链路：链路通但没人应答 hello
      const silent = new Memory()
      silent.open()
      return silent
    },
  }
})

/** 能手动上报链路状态的假链路（造 `connecting` 这一档只有我们能做，与 `link-reverify` 同一手法）。 */
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

interface TokenHost {
  spy: StateSpy
  /** 每次 `host.hello` 收到的 token（按顺序）—— 这就是本文件要盯的东西。 */
  tokens: string[]
  dispose: () => void
}

/** 可控电脑端：记录每次 hello 的 token；`issueGrant` 为 false 时模拟**旧版电脑端**（不回凭证）。 */
function setupHost(issueGrant: boolean): TokenHost {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const tokens: string[] = []
  const source = {
    async hello(params: { token?: string }): Promise<HelloResult> {
      tokens.push(params?.token ?? '')
      return {
        protocolVersion: 1,
        host: { platform: 'test', appVersion: '0' },
        capabilities: [],
        paired: true,
        deviceName: '电脑',
        deviceId: 'dk-demo',
        ...(issueGrant
          ? {
              grant: {
                token: 'gt-issued',
                issuedAt: Date.now(),
                expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
              },
            }
          : {}),
      } as HelloResult
    },
  } as unknown as HostDataSource
  const reg = registerHostHandlers(ep, source, { deviceName: '电脑' })
  return {
    spy: new StateSpy(mobileT),
    tokens,
    dispose: () => {
      reg.dispose()
      ep.dispose()
      hostT.close()
      mobileT.close()
    },
  }
}

/** 按 1 秒一步推进假时钟（与 `link-reverify` 同一口径，便于推理定时器链）。 */
async function advance(ms: number): Promise<void> {
  const steps = Math.ceil(ms / 1000)
  for (let i = 0; i < steps; i += 1) await vi.advanceTimersByTimeAsync(1000)
}

/** 扫码配对：token 是二维码里那张**一次性票据**。 */
function scanPair(host: TokenHost): Promise<boolean> {
  harness.queue.push(host.spy)
  return connectionStore.connect({
    hostId: 'dk-demo',
    deviceName: '电脑',
    token: 'pr-once',
    pairing: true,
  })
}

let hosts: TokenHost[] = []

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  harness.queue = []
  connectionStore.disconnect()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
})

afterEach(() => {
  connectionStore.disconnect()
  linkStore.detach()
  vi.useRealTimers()
  for (const host of hosts) host.dispose()
  hosts = []
})

describe('扫码配对后，重连令牌要换成凭证', () => {
  it('链路代际更替（对端重建）→ 重新授权用凭证，不再是那张已被兑换的票', async () => {
    const host = setupHost(true)
    hosts.push(host)
    expect(await scanPair(host)).toBe(true)
    expect(host.tokens).toEqual(['pr-once'])

    // 对端透明重建链路（电脑端 `dropLink` / 抖动）：本端只看到 connecting → open
    host.spy.emit('connecting')
    host.spy.emit('open')
    await advance(1000)

    /*
     * 票在那次配对里已经被电脑端消费（`redeemTicket` 删票）—— 再拿它握手只会得到
     * `ticket-expired`（手机端据此把用户打回登录页）。第二次必须用电脑端签发的凭证。
     */
    expect(host.tokens).toEqual(['pr-once', 'gt-issued'])
    expect(connectionStore.getSnapshot().status).toBe('online')
  })

  it('断线自动重连同样用凭证（不是「踢回登录页等重新扫码」）', async () => {
    const host = setupHost(true)
    hosts.push(host)
    expect(await scanPair(host)).toBe(true)

    // 链路闭死 → 退避 2 秒后重连；重连会建一条新链路（队列里给一个新的电脑端）
    const next = setupHost(true)
    hosts.push(next)
    harness.queue.push(next.spy)
    host.spy.emit('closed')
    await advance(4000)

    expect(next.tokens).toEqual(['gt-issued'])
    const s = connectionStore.getSnapshot()
    expect(s.status).toBe('online')
    expect(s.reconnecting).toBeUndefined()
  })

  it('旧版电脑端不回凭证 → 保留原令牌（兼容不退化）', async () => {
    const host = setupHost(false)
    hosts.push(host)
    expect(await scanPair(host)).toBe(true)

    host.spy.emit('connecting')
    host.spy.emit('open')
    await advance(1000)

    // 拿不到凭证时只能沿用原值 —— 旧行为，重点是**别把重连能力弄丢**
    expect(host.tokens).toEqual(['pr-once', 'pr-once'])
    expect(connectionStore.getSnapshot().status).toBe('online')
  })
})
