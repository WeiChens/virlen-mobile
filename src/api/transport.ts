/**
 * 传输选择 —— 手机端唯一的「换链路」改动点（见 docs/phone-control-bridge.md §6）。
 *
 * - **有信令基址** → `RtcTransport`（真链路，M3）；手机是 **guest**（电脑 host 发起 offer）。
 * - **无信令基址** → `BroadcastTransport`（同源跨 tab，M2 联调；生产不用）。
 *
 * ICE 列表由调用方用 `api/ice.ts` 的 `resolveIceFor()` 解析后传入（§31）：
 * **本文件里不再有任何 TURN 凭证**，默认值来自信令服务下发（`GET <基址>/ice`）。
 */
import {
  BroadcastTransport,
  RtcTransport,
  SseSignalingClient,
  roomFor,
  type IceServerInit,
  type Transport,
} from 'virlen-remote'
import { mobileIdentity } from '../lib/identity'

/** Broadcast 频道名由「电脑标识」派生 —— 与配对串/二维码里的 `host` 对应。 */
export const channelNameFor = (hostId: string): string => `virlen-remote:${hostId}`

export function createBroadcastTransport(hostId: string): BroadcastTransport {
  return new BroadcastTransport(channelNameFor(hostId))
}

export interface CreateTransportOptions {
  hostId: string
  /** 信令基址（存在则走 RTC 真链路）。 */
  signalUrl?: string
  /**
   * 信令房间号。**缺省由 `roomFor(hostId)` 派生**（`virlen:<电脑设备 key>`）—— 服务端就是这么判定的；
   * 只有旧二维码里显式带着房间号时才用它（逐字优先，兼容旧码）。
   */
  room?: string
  /**
   * ICE 服务器列表（由 `resolveIceFor()` 解析）。**缺省 = 仅本机候选**
   * （局域网可用）—— 不再有「偷偷用某个内置服务器」这回事。
   */
  iceServers?: IceServerInit[]
  /**
   * 观测钩子：RTC 链路建好 `RTCPeerConnection` 时回调（通讯状态面板据此读 `getStats()`）。
   *
   * 为什么能这么干：共享包把 `createPeerConnection` 特意留成了注入点（它自己测试也用），
   * 于是「到底走了 P2P 还是 TURN 中继」这种**只存在于本机候选对里**的事实，
   * 本端不必 fork 共享包就能读到（协议表里那个 `host.event.connection.changed`
   * 目前电脑端并不发，指望不上）。
   *
   * 不传 = 用共享包的默认工厂，连接行为完全一样（没有任何分支依赖它）。
   */
  onPeerConnection?: (pc: RTCPeerConnection) => void
}

/**
 * 造一个「造完就交出去」的 `RTCPeerConnection` 工厂。
 *
 * 与共享包默认工厂的区别**只有一处**：把实例交给观测钩子。因此这里的“环境有没有 RTCPeerConnection”
 * 检查必须与它同义 —— 少了它，本路径会从「一句明确的错误」退化成 `ReferenceError`（报错位置也更远）。
 */
function tracedFactory(onPeerConnection: (pc: RTCPeerConnection) => void) {
  return (config: RTCConfiguration): RTCPeerConnection => {
    const Ctor = (
      globalThis as { RTCPeerConnection?: new (c: RTCConfiguration) => RTCPeerConnection }
    ).RTCPeerConnection
    if (!Ctor) throw new Error('当前环境没有 RTCPeerConnection，无法建立 RTC 链路')
    const pc = new Ctor(config)
    onPeerConnection(pc)
    return pc
  }
}

/** 依据是否给出信令基址选择链路。 */
export function createTransport(options: CreateTransportOptions): Transport {
  if (options.signalUrl) {
    const identity = mobileIdentity()
    const signaling = new SseSignalingClient({
      baseUrl: options.signalUrl,
      /*
       * ⚠️ 2026-09-28 真机缺陷的修复点：这里**曾经**是 `options.room ?? options.hostId`
       * —— 把电脑 key 直接当房间名用了。M6 起二维码**不再携带 `room`**（设计决定：两端各自
       * 用 `roomFor(host)` 派生），于是手机拿 `host-xxxx` 去 join 服务端认的 `virlen:host-xxxx`
       * → 服务端回 404「房间不存在（电脑端未启用手机控制，或已关闭）」→ 手机把 `E_TRANSPORT`
       * 一律显示成「电脑不在线（本机未运行 Virlen，或未启用手机控制）」——**而电脑其实在线**。
       * 为什么 demo 没暴露：`dev/host-harness.ts` 的二维码显式带了 `room`，`options.room` 优先生效。
       * 派生逻辑两端同一份（共享包的 `roomFor`），**不要再在这里拼房间号字符串**。
       */
      room: options.room ?? roomFor(options.hostId),
      role: 'guest',
      // M6：手机身份上报（电脑端列表与凭证绑定都用它）
      deviceKey: identity.deviceKey,
      clientName: identity.name,
      /**
       * 房间内没有电脑（host）时就**不要挤进去**：
       * 空等 15 秒超时（旧行为）与立刻告诉用户「电脑不在线」是两种体验，
       * 而且占着 guest 位会让随后过来的真手机多一次顶号。
       */
      requireHostOnline: true,
    })
    return new RtcTransport({
      role: 'guest',
      signaling,
      iceServers: options.iceServers ?? [],
      // 只在有观测钩子时才换工厂：没钩子就用共享包的原样（少一处本端可出错的地方）
      ...(options.onPeerConnection
        ? { createPeerConnection: tracedFactory(options.onPeerConnection) }
        : {}),
    })
  }
  return createBroadcastTransport(options.hostId)
}
