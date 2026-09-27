/**
 * 回归（2026-09-28 真机）：**手机端 join 的房间号必须带 `virlen:` 前缀**。
 *
 * 缺陷形状：M6 起服务端把房间钉死为 `virlen:<电脑设备 key>`（`roomRegistry.join` 里对电脑侧还有一条
 * 「room 必须等于 virlen:<deviceKey>」的硬校验），同时二维码**不再携带 `room`** —— 设计决定是
 * 「两端各自用 `roomFor(host)` 派生」。电脑端照做了，手机端这一处却写成 `options.room ?? options.hostId`
 * （少了派生）：手机拿 `host-i3ko49zi` 去 join 服务端的 `virlen:host-i3ko49zi` → 服务端 404
 * 「房间不存在（电脑端未启用手机控制，或已关闭）」→ 手机把 `E_TRANSPORT` 一律归为 `offline`
 * → 界面显示「无法连接 / 电脑不在线（本机未运行 Virlen，或未启用手机控制）」，而电脑好端端在房间里。
 *
 * 为什么既有用例没抓到：其余用例都注入 transport（`connect({ transport })`），
 * `ice-config.test.ts` 更是把 `createTransport` 本身 mock 掉了 —— **恰好绕过这一行**；
 * 而 demo 用的 `dev/host-harness.ts` 二维码里显式带 `room`，`options.room` 优先生效，把缺陷盖住了。
 *
 * 因此这里**不注入、不 mock** `createTransport`：走真实 `SseSignalingClient`，
 * 只把 `fetch` / `EventSource` / `BroadcastChannel` 换成桩，断言「实际发出去的 join 请求体里的 room」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BroadcastTransport, roomFor } from 'virlen-remote'
import { createTransport } from '../api/transport'

const SIGNAL = 'https://signal.example/api/rtc/'

interface RecordedRequest {
  url: string
  body: Record<string, unknown> | null
}

/** 装一套网络桩：记录请求 + 让 join 走通（本用例不建 WebRTC，故不会用到 RTCPeerConnection）。 */
function stubNetwork(): { calls: RecordedRequest[]; channelNames: string[] } {
  const calls: RecordedRequest[] = []
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
    calls.push({
      url: String(url),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    })
    // 「电脑在线」的合法应答：房间号回显为空无妨，本用例只看请求侧
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'c1', room: '', role: 'guest', hostOnline: true, peers: [] }),
    }
  })
  // jsdom 既没有 EventSource（`SseSignalingClient.openEvents()` 需要），也没有 BroadcastChannel
  vi.stubGlobal(
    'EventSource',
    class {
      onopen: ((event: unknown) => void) | null = null
      onerror: ((event: unknown) => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      close(): void {}
    },
  )
  const channelNames: string[] = []
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      onmessage: ((event: unknown) => void) | null = null
      constructor(name: string) {
        channelNames.push(name)
      }
      postMessage(): void {}
      close(): void {}
    },
  )
  return { calls, channelNames }
}

/** 取 `join` 请求（断言「真的发出去了」比断言 undefined 更有信息量）。 */
function joinRequest(calls: RecordedRequest[]): RecordedRequest {
  const call = calls.find((c) => c.url.endsWith('/join'))
  expect(call, '应当发出过 POST <基址>/join').toBeTruthy()
  return call as RecordedRequest
}

/**
 * 建一条链路，并**先接住 `whenReady()`**。
 *
 * 为什么必须接：`RtcTransport.close()` 会让未被消费的 `whenReady()` 以「transport closed」拒绝，
 * 不接就变成未处理拒绝 —— 用例全绿但进程以非 0 退出。
 */
function openTransport(options: Parameters<typeof createTransport>[0]) {
  const transport = createTransport(options)
  transport.whenReady?.().catch(() => {})
  return transport
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('手机端信令房间号（由 roomFor 派生）', () => {
  it('新式电脑 key（dk-…）→ 房间 virlen:dk-…', async () => {
    const { calls } = stubNetwork()
    const transport = openTransport({ hostId: 'dk-0123456789abcdef', signalUrl: SIGNAL })
    await transport.start?.()

    const join = joinRequest(calls)
    expect(join.url).toBe(`${SIGNAL}join`)
    expect(join.body?.room).toBe(roomFor('dk-0123456789abcdef'))
    expect(join.body?.room).toBe('virlen:dk-0123456789abcdef')
    // guest 身份与「电脑不在线就别占位」的开关一并锁住
    expect(join.body?.role).toBe('guest')
    transport.close()
  })

  it('旧式电脑 key（host-…，线上实际遇到的那种）→ 房间 virlen:host-…', async () => {
    const { calls } = stubNetwork()
    const transport = openTransport({ hostId: 'host-i3ko49zi', signalUrl: SIGNAL })
    await transport.start?.()

    // 缺陷版本这里是 'host-i3ko49zi'（服务端会 404「房间不存在」）
    expect(joinRequest(calls).body?.room).toBe('virlen:host-i3ko49zi')
    transport.close()
  })

  it('显式 room 优先（旧二维码里带着房间号时逐字用它），且不再二次加前缀', async () => {
    const { calls } = stubNetwork()
    const transport = openTransport({
      hostId: 'host-i3ko49zi',
      signalUrl: SIGNAL,
      room: 'virlen:host-legacy-room',
    })
    await transport.start?.()

    expect(joinRequest(calls).body?.room).toBe('virlen:host-legacy-room')
    transport.close()
  })

  it('无信令基址 → Broadcast，频道名仍是**原始电脑标识**（两端对齐这里，不能顺带加前缀）', () => {
    const { channelNames } = stubNetwork()
    const transport = openTransport({ hostId: 'host-i3ko49zi' })

    expect(transport).toBeInstanceOf(BroadcastTransport)
    expect(channelNames).toEqual(['virlen-remote:host-i3ko49zi'])
    transport.close()
  })
})
