/**
 * 连接状态机（登录页的业务核心）。
 *
 * 三种「登录结果」：
 * - 成功 → `online`（进入 chat 页）
 * - **不在线** → 电脑端无响应（hello 超时 / 链路不可用）→ `error: 'offline' | 'timeout'`
 * - **被拒绝** → 电脑端明确拒绝（令牌过期 / 设备被移除）→ `error: 'denied'`
 */
import {
  BridgeError,
  Endpoint,
  createCaller,
  type HelloResult,
  type HostApi,
  type Transport,
  type TransportState,
} from 'virlen-remote'
import { Store } from '../lib/store'
import { mobileIdentity } from '../lib/identity'
import { createTransport } from '../api/transport'
import { resolveIceFor } from '../api/ice'
import { clearActive, setActive } from '../api/active'
import { devicesStore } from './devices'
import { chatStore } from './chat'

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'error'

/**
 * 登录失败的原因（M6 起细分）。
 *
 * 为什么要分这么细：「被拒绝」是一族**动作完全不同**的情况 —— 凭证过期要重新扫码、
 * 被移除要重新扫码并等电脑确认、二维码过期只要重扫、被顶号**不能自动重连**、
 * 电脑不在线则只需稍后重试。笼统一个 `denied` 会让用户不知道该做什么。
 */
export type ConnectErrorReason =
  | 'offline'
  | 'timeout'
  | 'denied'
  | 'expired'
  | 'revoked'
  | 'ticket-expired'
  | 'replaced'
  | 'version'
  | 'unknown'

/**
 * 链路状态（M5）。
 *
 * 与 `status` 的区别：`status` 是**登录结果**（未连接 / 连接中 / 已登录 / 出错），
 * `link` 是**当前链路的健康度** —— 已登录后也可能掉线（手机切后台 / 换网 / 电脑休眠）。
 * 分层的原因：掉线不应把用户踢回登录页（会话与消息还在内存里），只需要告诉他「现在收不到」。
 */
export type LinkState = 'open' | 'connecting' | 'closed'

export interface ConnectionState {
  status: ConnectionStatus
  targetName?: string
  device?: { id: string; name: string }
  capabilities: string[]
  /** 链路健康度（`closed` 时需重建链路，见 `reconnectNow`）。 */
  link: LinkState
  /** 自动重连进度（进行中才有值）；次数用尽后消失，由 UI 给「重新连接」。 */
  reconnecting?: { attempt: number; total: number }
  error?: { reason: ConnectErrorReason; message: string }
}

export interface ConnectOptions {
  hostId: string
  deviceName: string
  token: string
  /** 信令基址（存在则走 RTC 真链路；无则同源 Broadcast 联调）。 */
  signalUrl?: string
  /** 信令房间号（默认由 hostId 派生）。 */
  room?: string
  /**
   * 测试注入：直接指定 transport。
   * 生产路径不传 —— 由 `createTransport` 按 `signalUrl` 选择（M3 RTC / M2 Broadcast）。
   */
  transport?: Transport
  /**
   * 内部：`reconnect` = 掉线后的重建尝试。
   *
   * 语义差别：重连失败**不把 status 置为 `error`**（那会把用户踢回登录页），
   * 只保持 `link:'closed'` 并继续退避或等用户手动重连。
   */
  mode?: 'connect' | 'reconnect'
}

/** hello 握手超时：超过即判定「电脑不在线」。 */
const HELLO_TIMEOUT_MS = 4000
/** 链路建立（信令 + ICE / Broadcast）超时。RTC 打洞较慢，给宽一点。 */
const LINK_TIMEOUT_MS = 15_000
/**
 * 自动重连的退避间隔（ms）。第 N 项 = 第 N 次尝试前的等待。
 *
 * 次数**有限**是刻意的：手机可能真的回不到那个网络（电脑关机 / 换网段），
 * 无限重试只会白耗电量与流量，且用户看不出「在重试」与「已放弃」的区别。
 */
const RECONNECT_DELAYS = [2000, 5000, 10_000]
/**
 * 手机端声明的能力（与电脑侧 ACL **取交集**驱动 UI 显隐，§3.5）。
 *
 * ⚠️ 当前电脑侧 hello 直接回 ACL 能力集（不做交集），此处声明是**双向协商的输入**，
 * 也为将来真正取交集做好准备 —— 不能省。
 */
const CLIENT_CAPABILITIES = [
  'session.list',
  'session.send',
  'session.cancel',
  'session.resume',
  'session.create',
  'session.rename',
  'session.pin',
  'session.delete',
  'session.model',
  'session.workspace',
  'session.context',
  'session.compress',
  'interaction.answer',
  'stream.delta',
]

interface ActiveConnection {
  transport: Transport
  endpoint: Endpoint
}

let active: ActiveConnection | null = null

class ConnectionStore extends Store<ConnectionState> {
  constructor() {
    super({ status: 'idle', capabilities: [], link: 'closed' })
  }

  /** 当前链路的「状态变化」退订函数（换链路时必须先退订旧的，否则旧链路的 closed 会引发误重连）。 */
  private offLink: (() => void) | null = null
  /** 当前链路的「致命错误」退订函数（被顶号 = E_REPLACED）。 */
  private offError: (() => void) | null = null
  /** 本次连接是否被顶号：置位后**不再自动重连**（否则两台手机会互相顶号）。 */
  private replaced = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  /** 重连所需的最小信息（**不存 transport**：重建链路必须新建，旧的对端已不可用）。 */
  private lastOptions: ConnectOptions | null = null

  /**
   * 尝试连接。**返回是否成功**（同时把结果写入状态，供 UI 渲染三种态）。
   * 失败不抛出 —— 登录页按状态渲染即可。
   */
  async connect(options: ConnectOptions): Promise<boolean> {
    const isReconnect = options.mode === 'reconnect'
    this.clearReconnectTimer()
    this.closeActive()
    // 被顶号的标记只对「上一次连接」有意义：主动重连时清零，否则会把新链路当成旧链路处理
    this.replaced = false
    if (isReconnect) {
      this.setState((s) => ({ ...s, link: 'connecting' }))
    } else {
      this.reconnectAttempt = 0
      this.setState({
        status: 'connecting',
        targetName: options.deviceName,
        capabilities: [],
        link: 'connecting',
      })
    }

    /*
     * ICE 默认值来自信令服务下发（§31）—— 本端源码里不再有任何 TURN 凭证。
     *
     * 解析在任何建链路动作**之前**（`RTCPeerConnection` 的 iceServers 构造后改不了）；
     * 共享包内部有 6 小时本地缓存，正常情况不会每次都发请求。
     * 注入 `transport`（用例 / Broadcast 联调）时跳过：那条路径根本不建 PeerConnection。
     */
    const ice = options.transport || !options.signalUrl ? null : await resolveIceFor(options.signalUrl)
    const transport =
      options.transport ??
      createTransport({
        hostId: options.hostId,
        signalUrl: options.signalUrl,
        room: options.room,
        ...(ice ? { iceServers: ice.servers } : {}),
      })
    const endpoint = new Endpoint({ transport, defaultTimeoutMs: 10_000 })
    // 链路健康度：掉线（`disconnected`→`connecting` / `failed`→`closed`）由它上报
    this.offLink = transport.onStateChange((state) => this.onLinkState(state))
    // 致命错误（被顶号）单独一条通道：它对应的动作与「掉线」**相反**（不能自动重连）
    this.offError = transport.onError?.((err) => this.onLinkError(err)) ?? null

    try {
      // 1) 启动链路（RTC：加入信令房间 + 协商；Broadcast：无需启动）
      await Promise.resolve(transport.start?.())
      // 2) 等链路 open（RTC 需等 DataChannel 真正可用，否则 hello 会因 E_TRANSPORT 直接失败）
      await withTimeout(transport.whenReady ? transport.whenReady() : Promise.resolve(), LINK_TIMEOUT_MS)

      const caller = createCaller<HostApi>(endpoint)
      const identity = mobileIdentity()
      const hello: HelloResult = await caller.call(
        'host.hello',
        {
          protocolVersion: 1,
          client: { platform: detectPlatform(), appVersion: '0.1.0' },
          capabilities: CLIENT_CAPABILITIES,
          token: options.token,
          // M6：手机身份 —— 电脑端用它建「已绑定手机」列表项，并把它绑在授权凭证上
          mobileKey: identity.deviceKey,
          mobileName: identity.name,
          /**
           * §32：声明本端能按**增量帧**解析流式正文。
           *
           * 为何必须由客户端声明：老客户端（已缓存的 PWA）会把一帧增量当成全文渲染 ——
           * 那就不是带宽问题而是**正文错位**。不声明就继续收整帧（`store-bridge` 默认 `full`）。
           * 声明了但电脑端是旧版也别怕：旧版不认这个参数，照旧发整帧，本端同样能渲染。
           */
          streamMode: 'delta',
        },
        HELLO_TIMEOUT_MS,
      )

      active = { transport, endpoint }
      setActive(endpoint, caller)

      const device = {
        id: hello.deviceId || options.hostId,
        name: hello.deviceName || options.deviceName,
      }
      // 能力集交给 chatStore：PWA 总是最新的，而电脑端可能是旧版本 ——
      // 旧电脑没有的新能力对应的方法一律**静默不发**（而不是把 E_DENIED 顶到界面上）
      chatStore.setCapabilities(hello.capabilities)
      devicesStore.upsert({
        hostKey: device.id,
        name: device.name,
        // ⚠️ 存**电脑端回传的凭证**，不是手上那张一次性票据（§30.3）：
        //    旧版电脑端不回 grant，则退回用本次令牌（旧行为，不弄丢设备记录）
        grant: hello.grant?.token ?? options.token,
        ...(hello.grant ? { issuedAt: hello.grant.issuedAt, expiresAt: hello.grant.expiresAt } : {}),
        signalUrl: options.signalUrl,
        room: options.room,
        lastConnectedAt: Date.now(),
      })
      this.reconnectAttempt = 0
      // 注入的 transport 不能用于重连（测试 / 联调专用），故不记住重连参数
      this.lastOptions = options.transport ? null : { ...options, mode: 'connect' }
      this.setState({
        status: 'online',
        device,
        capabilities: hello.capabilities,
        link: 'open',
        reconnecting: undefined,
        error: undefined,
      })
      return true
    } catch (err) {
      endpoint.dispose()
      transport.close()
      this.offLink?.()
      this.offLink = null
      this.offError?.()
      this.offError = null
      if (isReconnect) {
        // 重连失败：不把用户踢回登录页（会话与消息还在内存），由退避继续或等手动重连
        this.setState((s) => ({ ...s, link: 'closed' }))
        return false
      }
      const reason = classifyError(err)
      this.setState({
        status: 'error',
        targetName: options.deviceName,
        capabilities: [],
        link: 'closed',
        error: { reason, message: describeError(err, reason) },
      })
      return false
    }
  }

  /** 断开并回到登录页。 */
  disconnect(): void {
    // 用户主动断开：清掉重连信息，否则下一次链路抖动会「自动连回去」
    this.lastOptions = null
    this.reconnectAttempt = 0
    this.clearReconnectTimer()
    this.closeActive()
    chatStore.reset()
    this.setState({ status: 'idle', capabilities: [], link: 'closed', reconnecting: undefined })
  }

  /**
   * 手动重连（自动重连失败后由 UI 提供，或用户主动点）。
   *
   * 复用已保存的设备信息重建链路（**不是**重新扫码 —— 配对令牌仍在手机本地）。
   */
  reconnectNow(): void {
    const opts = this.lastOptions
    if (!opts) return
    this.reconnectAttempt = 0
    this.clearReconnectTimer()
    void this.connect({ ...opts, mode: 'reconnect' }).then((ok) => {
      if (!ok) this.scheduleReconnect()
    })
  }

  /** 链路状态上报（`Transport` 的 `onStateChange`）。 */
  private onLinkState(state: TransportState): void {
    // 被顶号：后续的状态变化（closed）不再参与任何决策 —— 重连会去抢别人的线
    if (this.replaced) return
    const cur = this.getSnapshot()
    if (state === 'open') {
      this.reconnectAttempt = 0
      this.clearReconnectTimer()
      if (cur.link !== 'open' || cur.reconnecting) {
        this.setState({ ...cur, link: 'open', reconnecting: undefined })
      }
      return
    }
    const link: LinkState = state === 'connecting' ? 'connecting' : 'closed'
    if (cur.link !== link) this.setState({ ...cur, link })
    // 已登录状态下链路闭死 → 只能重建（`Transport` 无 `reconnect()`，见 §20.3-4）
    if (state === 'closed' && cur.status === 'online' && this.lastOptions) {
      this.scheduleReconnect()
    }
  }

  /**
   * 链路级错误（`Transport.onError`）。
   *
   * 目前只有一种需要特殊处理：**被顶号**（`E_REPLACED`）。它与「掉线」的动作完全相反 ——
   * 掉线要退避重连，被顶号则**绝不能重连**：重连会把刚接入的那台手机顶掉，
   * 两台手机就会来回抢线（服务端的顶号是「后来者优先」）。
   */
  private onLinkError(err: unknown): void {
    if (!(err instanceof BridgeError) || err.code !== 'E_REPLACED') return
    this.replaced = true
    this.clearReconnectTimer()
    // 清掉重连参数：用户手动点「连接」时才会重新发起（那时再抢回控制权是明确意图）
    this.lastOptions = null
    this.closeActive()
    chatStore.reset()
    this.setState({
      status: 'error',
      capabilities: [],
      link: 'closed',
      reconnecting: undefined,
      error: { reason: 'replaced', message: describeError(err, 'replaced') },
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = RECONNECT_DELAYS[this.reconnectAttempt]
    if (delay === undefined) {
      // 退避次数用尽：停止重试，保持 link='closed'，由 UI 给「重新连接」
      this.setState((s) => ({ ...s, reconnecting: undefined }))
      return
    }
    const attempt = this.reconnectAttempt + 1
    this.reconnectAttempt = attempt
    this.setState((s) => ({ ...s, reconnecting: { attempt, total: RECONNECT_DELAYS.length } }))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      const opts = this.lastOptions
      if (!opts) return
      if (this.getSnapshot().status !== 'online') return
      void this.connect({ ...opts, mode: 'reconnect' }).then((ok) => {
        if (!ok) this.scheduleReconnect()
      })
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /** 从错误态回到可重试的 idle。 */
  clearError(): void {
    if (this.getSnapshot().status === 'error') {
      this.setState({ status: 'idle', capabilities: [], link: 'closed' })
    }
  }

  private closeActive(): void {
    // 先退订旧链路的回调：`transport.close()` 会同步/异步地引发状态变化，
    // 若此时回调还挂着，会把「正在重连」误判成「又掉线了一次」
    this.offLink?.()
    this.offLink = null
    this.offError?.()
    this.offError = null
    if (active) {
      active.endpoint.dispose()
      active.transport.close()
      active = null
    }
    clearActive()
  }
}

function detectPlatform(): string {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios-web'
  if (/Android/i.test(ua)) return 'android-web'
  return 'web'
}

function classifyError(err: unknown): ConnectErrorReason {
  if (err instanceof BridgeError) {
    if (err.code === 'E_REPLACED') return 'replaced'
    if (err.code === 'E_DENIED') {
      // 电脑端的拒因（`data.reason`，§30.5）：能区分就不要当成笼统的「被拒」——
      // 用户看到「重新扫码」与看到「被拒绝」能做的事完全不同
      const detail = (err.data as { reason?: unknown } | undefined)?.reason
      if (detail === 'expired') return 'expired'
      if (detail === 'revoked') return 'revoked'
      if (detail === 'ticket-expired') return 'ticket-expired'
      return 'denied'
    }
    if (err.code === 'E_TIMEOUT') return 'timeout'
    if (err.code === 'E_UNSUPPORTED') return 'version'
    if (err.code === 'E_TRANSPORT') return 'offline'
  }
  // 非 BridgeError：多为链路建立失败（RTCPeerConnection 失败 / 信令异常）→ 归为不在线
  return 'offline'
}

/** 给 Promise 加超时（超时抛 `E_TIMEOUT`，供 classifyError 归类）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BridgeError('E_TIMEOUT', '链路建立超时')), ms)
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * 错误 → 用户可读的文案（尽量直说「现在该做什么」）。
 *
 * 约定：涉及凭证的三种情况（`expired` / `revoked` / `ticket-expired`）文案里必须出现「扫码」——
 * 否则用户只会反复点「连接」而不去电脑前重新出码。
 */
function describeError(err: unknown, reason: ConnectErrorReason): string {
  switch (reason) {
    case 'offline':
      return '电脑不在线（本机未运行 Virlen，或未启用手机控制）'
    case 'timeout':
      return '连接超时：电脑没有响应'
    case 'version':
      return '协议版本不匹配，请升级客户端'
    case 'replaced':
      return '该电脑已被另一台手机接管连接'
    case 'expired':
      return '授权凭证已过期（最长 90 天），请在电脑上重新扫码配对'
    case 'revoked':
      return '这台手机已被电脑端移除，请重新扫码并由电脑确认'
    case 'ticket-expired':
      return '二维码已过期，请重新扫描电脑上的新二维码'
    case 'denied':
      return err instanceof Error && err.message ? err.message : '电脑端拒绝了本次连接'
    default:
      return err instanceof Error ? err.message : '连接失败'
  }
}

export const connectionStore = new ConnectionStore()
