/**
 * 现场配对的握手等待（真机反馈：电脑端在弹窗等用户点确认）。
 *
 * 首次配对**不是**机器对机器：电脑端 `host.hello` 里 `await confirmPair(...)`，
 * 用户点完「允许」才回话（见电脑端 `host-source`）。手机端若用默认的 4 秒握手超时，
 * 真机表现就是「手机说电脑不在线/超时，可电脑明明弹了窗」。
 *
 * 这里用假定时器把「等 60 秒」这件事本身钉住 —— 只改一个常量很容易在后续重构里
 * 被顺手改回 4 秒，而这类回归只有真机上才看得见。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryPair, type MemoryTransport } from 'virlen-remote'
import { connectionStore } from '../store/connection'

/**
 * 一条**没人应答**的链路：对端不注册任何 Endpoint。
 *
 * 等价于「电脑端还停在确认弹窗上」—— 帧发出去了，但 hello 的应答要等用户点。
 */
function silentLink(): MemoryTransport {
  const [, mobile] = createMemoryPair()
  return mobile
}

function connect(mobile: MemoryTransport, pairing: boolean): Promise<boolean> {
  return connectionStore.connect({
    hostId: 'dk-demo',
    deviceName: '演示电脑',
    // 现场配对手上是一次性票据（`pr-`）；已配对设备手上是长期凭证（`gt-`）
    token: pairing ? 'pr-ticket' : 'gt-grant',
    transport: mobile,
    pairing,
  })
}

describe('现场配对的握手超时（电脑端要等用户授权）', () => {
  afterEach(() => {
    connectionStore.disconnect()
    vi.useRealTimers()
  })

  it('pairing：等满 59 秒仍是「连接中」（用户还在看弹窗），满 60 秒才判超时', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const pending = connect(silentLink(), true)

    await vi.advanceTimersByTimeAsync(59_000)
    expect(connectionStore.getSnapshot().status).toBe('connecting')

    await vi.advanceTimersByTimeAsync(1_500)
    expect(await pending).toBe(false)
    const state = connectionStore.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error?.reason).toBe('timeout')
  })

  it('已配对设备（凭证直连）：仍是 4 秒快失败，不被配对的长等待拖慢', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const pending = connect(silentLink(), false)

    await vi.advanceTimersByTimeAsync(4_500)
    expect(await pending).toBe(false)
    expect(connectionStore.getSnapshot().error?.reason).toBe('timeout')
  })
})
