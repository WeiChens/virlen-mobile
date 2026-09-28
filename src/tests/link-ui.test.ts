/**
 * 通讯状态面板的渲染冒烟用例。
 *
 * 为什么值得写：这一层全是**「读不到就给 null」的字段**（候选对还没定型、本机不给字节计数、
 * ICE 压根没解析过……），而 UI 出错的方式不是抛异常、而是**显示一句假话**
 * （把未知说成直连）。用例直接把两种极端状态渲染出来看一眼。
 *
 * ⚠️ 破例说明（与 §21.4 的取舍一致）：UI 逻辑一律先落成纯函数，这里只钉「渲染结果里
 * 有没有出现正确的那句话」。真机上的 WebRTC 跑不进 CI，所以假 PC 喂进去即可。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import LinkSheet from '../ui/components/LinkSheet'
import { linkStore, type RtcPeer } from '../store/link'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 假 PeerConnection：只喂 stats，状态恒为 connected。 */
class FakePeer implements RtcPeer {
  readonly connectionState = 'connected'
  constructor(private readonly list: unknown[]) {}

  getStats(): Promise<{ forEach(callback: (entry: unknown) => void): void }> {
    return Promise.resolve({ forEach: (cb: (entry: unknown) => void) => this.list.forEach(cb) })
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** 一条经 TURN 中继的候选对（本端 host ↔ 对端 relay）。 */
const RELAY_STATS = [
  { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
  {
    type: 'candidate-pair',
    id: 'P0',
    localCandidateId: 'L0',
    remoteCandidateId: 'R0',
    state: 'succeeded',
    currentRoundTripTime: 0.21,
    responsesReceived: 12,
  },
  { id: 'L0', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
  { id: 'R0', type: 'remote-candidate', candidateType: 'relay' },
  { type: 'data-channel', id: 'DC0', bytesSent: 2048, bytesReceived: 4096, messagesSent: 4, messagesReceived: 9 },
]

let container: HTMLDivElement | null = null
let root: Root | null = null

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
  linkStore.detach()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
  linkStore.detach()
})

describe('LinkSheet —— 通讯状态面板', () => {
  it('还没挂上链路：说清「本次不是 WebRTC」，不假装知道通道类型', () => {
    const text = mount()
    expect(text).toContain('通讯状态')
    expect(text).toContain('已断开')
    expect(text).toContain('本次链路不是 WebRTC')
    // 没有候选对就**不显示**那一块（宁可不显示，也不能把未知说成直连）
    expect(text).not.toContain('P2P 直连')
    expect(text).not.toContain('TURN 中继')
  })

  it('挂上一条中继链路：通道 / 候选 / 延迟 / 收发量都摆出来', async () => {
    linkStore.attach(new FakePeer(RELAY_STATS))
    await act(async () => {})
    const text = mount()

    expect(text).toContain('连接方式')
    expect(text).toContain('TURN 中继')
    expect(text).toContain('TURN 中继服务器')
    expect(text).toContain('本机地址（同网段）')
    expect(text).toContain('UDP')
    expect(text).toContain('210 ms')
    expect(text).toContain('2.0 KB')
    expect(text).toContain('4.0 KB')
    expect(text).toContain('9 条消息')
  })

  it('重连区把「3 次用尽就退回登录页」写在明面上（用户要知道尽头在哪）', () => {
    const text = mount()
    expect(text).toContain('用尽后自动退回登录页')
    expect(text).toContain('立即重连')
    expect(text).toContain('断开并返回登录页')
  })
})
