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
  /** 信令房间号（默认由 hostId 派生）。 */
  room?: string
  /**
   * ICE 服务器列表（由 `resolveIceFor()` 解析）。**缺省 = 仅本机候选**
   * （局域网可用）—— 不再有「偷偷用某个内置服务器」这回事。
   */
  iceServers?: IceServerInit[]
}

/** 依据是否给出信令基址选择链路。 */
export function createTransport(options: CreateTransportOptions): Transport {
  if (options.signalUrl) {
    const identity = mobileIdentity()
    const signaling = new SseSignalingClient({
      baseUrl: options.signalUrl,
      room: options.room ?? options.hostId,
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
    return new RtcTransport({ role: 'guest', signaling, iceServers: options.iceServers ?? [] })
  }
  return createBroadcastTransport(options.hostId)
}
