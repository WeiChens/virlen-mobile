/**
 * 链路观测 —— 通讯状态面板的数据源（手机端「一直盯着 RTC」的那只眼睛）。
 *
 * ## 它解决什么
 *
 * 在此之前，手机端第一次知道「链路断了」的时机往往很尴尬：**发消息时**（RPC 10 秒后才超时）。
 * 而 `RTCPeerConnection` 有两种「死」：
 *  1. **吵的死**：`connectionState` 变 `disconnected` / `failed` → `Transport` 会上报状态变化
 *     （这条路本来就有，`connectionStore` 在听）；
 *  2. **静的死**：网络断了（离开 WiFi / 蜂窝进电梯），链路两端的对象都还觉得自己连着，
 *     `connectionState` 可以**停在 `connected` 好几秒到几十秒**不吭声。这段时间里界面写着
 *     「在线」，发出去的消息却全落进 `DataChannel` 的黑洞。
 *
 * 本模块用**主动心跳**覆盖第 2 种：链路开着时每 `LINK_HEARTBEAT_MS` 发一个协议层的
 * `endpoint.ping()`（电脑端收到会自动回 `pong`，见共享包 `Endpoint.onCtrl`），
 * 再用 `getStats()` 里数据通道的**接收字节数**判断「回音到底有没有来」。
 *
 * ## 三条安全阀（宁可漏判，也不能把好链路判死）
 *
 *  - **没有判据就不判**：本机读不到接收字节数（部分实现不给这个字段）→ `silentMs = null`，
 *    永不触发失联（只显示「无判据」）；
 *  - **只认「ping 之后一次都没收到」**：空闲链路本来就没流量，不能因为「安静」判死；
 *  - **连续三个周期**（`LINK_STALL_MS`）没有任何字节才算死 —— 单次卡顿、丢一帧都不算。
 *
 * 判死之后不是自己动手重连，而是**通知连接层**（`onStall`）——重连的账由
 * `connectionStore` 一家记，否则「重连了 3 次」这个数字会被两处各自加一次。
 */
import { Store } from '../lib/store'
import { getEndpoint } from '../api/active'
import {
  rxCounterOf,
  statsEntries,
  summarizeRtcStats,
  type LinkPath,
  type RtcSample,
  type StatsReportLike,
} from '../lib/rtc-stats'

/** 采样间隔（ms）。一次 `getStats()` 只有几毫秒，2 秒够跟上「候选对换了」这种变化。 */
export const LINK_SAMPLE_MS = 2000
/** 心跳间隔（ms）。链路开着时定期发一个协议层 ping，电脑端自动回 pong。 */
export const LINK_HEARTBEAT_MS = 5000
/**
 * 判失联的阈值（ms）：发过心跳之后，这么久仍没从电脑收到**任何字节** → 判定链路已死。
 *
 * 取 3 个心跳周期：一次慢、一次丢，都不该算死。
 */
export const LINK_STALL_MS = 15_000

/**
 * 本模块用到的 `RTCPeerConnection` 最小形状。
 *
 * 声明成结构类型而不是直接用 `RTCPeerConnection`：真实 WebRTC 跑不进 CI，
 * 假对象能喂进来，判定逻辑才可能有测试。
 */
export interface RtcPeer {
  getStats(): Promise<StatsReportLike>
  readonly connectionState?: string
  addEventListener?(type: 'connectionstatechange', listener: () => void): unknown
  removeEventListener?(type: 'connectionstatechange', listener: () => void): unknown
}

/** 链路附加信息（由连接层提供；拿不到就不显示）。 */
export interface LinkProbe {
  /** 未发出去的字节数（背压观察点）—— 即 `Transport.bufferedAmount`。 */
  bufferedAmount?: () => number
}

/** 面板要显示的全部链路状态。 */
export interface LinkView {
  /** 是否挂上了 PeerConnection。**没有也不代表链路不通**：同源 Broadcast 联调就没有。 */
  attached: boolean
  path: LinkPath
  localType: string | null
  remoteType: string | null
  protocol: string | null
  rttMs: number | null
  bytesSent: number | null
  bytesReceived: number | null
  messagesSent: number | null
  messagesReceived: number | null
  /** 未发出去的字节数（持续很大 = 链路在积压）。 */
  bufferedAmount: number
  /** 本次链路挂上来的时刻（0 = 没挂）。 */
  since: number
  /** 最近一次采样时刻（0 = 还没采过）。 */
  sampledAt: number
  /**
   * 最近一次「从电脑收到字节」的时刻。
   * `null` = 还没收到过 / 本机读不到接收计数（后者意味着**失联判定不可用**）。
   */
  lastRxAt: number | null
  /** 链路已经安静多久（ms）；`null` = 没有判据（见 `lastRxAt`）。 */
  silentMs: number | null
  /** 已判定失联（通知过一次连接层；链路重建后归 false）。 */
  stalled: boolean
  /** 采样失败的原因（环境不支持 / `getStats()` 抛错）。 */
  error?: string
}

/** 未挂链路时的初始态（**同一个引用**：反复 detach 不该反复通知订阅者）。 */
const EMPTY_VIEW: LinkView = {
  attached: false,
  path: 'unknown',
  localType: null,
  remoteType: null,
  protocol: null,
  rttMs: null,
  bytesSent: null,
  bytesReceived: null,
  messagesSent: null,
  messagesReceived: null,
  bufferedAmount: 0,
  since: 0,
  sampledAt: 0,
  lastRxAt: null,
  silentMs: null,
  stalled: false,
}

type StallHandler = (silentMs: number) => void

class LinkMonitor extends Store<LinkView> {
  constructor() {
    super(EMPTY_VIEW)
  }

  private pc: RtcPeer | null = null
  private probe: LinkProbe = {}
  private sampleTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private offConnState: (() => void) | null = null
  private offVisibility: (() => void) | null = null
  /** 上一次的接收计数（用来发现「增长」）。 */
  private lastCounter: number | null = null
  /**
   * 判失联的基准时刻 = 「最后一次确认链路还活着」的时刻（收到字节 / attach / 回到前台时重置）。
   *
   * ⚠️ 与视图里的 `since`（链路挂上来的时刻，面板的「已连接时长」）**分开存**：
   * 回到前台要重置的是前者，而后者是给人看的事实，不能跟着变。
   */
  private baselineAt = 0
  /** 最近一次发出心跳的时刻（0 = 还没发过）。 */
  private lastPingAt = 0
  /** 上一轮采样还没回来（`getStats()` 是异步的，别叠加）。 */
  private sampling = false
  private readonly stallHandlers = new Set<StallHandler>()

  /**
   * 挂上一条链路开始观测（`RtcTransport` 造出 PC 时由连接层调用）。
   *
   * 传的是**新的 PC** 时自动先 `detach()`：换链路 = 结论全部作废
   * （候选对、计数、安静时长都属于上一条链路，带着走只会显示错的数字）。
   */
  attach(pc: RtcPeer, probe: LinkProbe = {}): void {
    if (this.pc === pc) return
    this.detach()
    this.pc = pc
    this.probe = probe
    const now = Date.now()
    this.baselineAt = now
    this.setState({ ...EMPTY_VIEW, attached: true, since: now })

    // 自己挂一个 listener（**不用** `onconnectionstatechange` 赋值：那个属性归共享包的 transport 用）
    const onStateChange = (): void => {
      if (pc.connectionState === 'closed') this.detach()
    }
    pc.addEventListener?.('connectionstatechange', onStateChange)
    this.offConnState = () => pc.removeEventListener?.('connectionstatechange', onStateChange)
    this.offVisibility = watchBecomeVisible(() => this.rebaseline())

    this.sampleTimer = setInterval(() => void this.sample(), LINK_SAMPLE_MS)
    this.heartbeatTimer = setInterval(() => this.beat(), LINK_HEARTBEAT_MS)
    // 立刻先采一次：面板一打开就该有数字，而不是等 2 秒
    void this.sample()
  }

  /** 摘掉链路（换链路 / 掉线 / 断开都会走到这里）。 */
  detach(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.sampleTimer = null
    this.heartbeatTimer = null
    this.offConnState?.()
    this.offConnState = null
    this.offVisibility?.()
    this.offVisibility = null
    this.pc = null
    this.probe = {}
    this.lastCounter = null
    this.lastPingAt = 0
    this.baselineAt = 0
    this.sampling = false
    this.setState(EMPTY_VIEW)
  }

  /** 订阅「判定失联」（连接层据此走重连；本模块自己不动手）。 */
  onStall(handler: StallHandler): () => void {
    this.stallHandlers.add(handler)
    return () => {
      this.stallHandlers.delete(handler)
    }
  }

  /* ───────────────────────────── 心跳 ───────────────────────────── */

  /**
   * 发一次协议层心跳。
   *
   * `ping()` 在链路非 open 时返回 false —— 那是**链路状态机**的事（它会自己上报，连接层会重连），
   * 这里不越权判失联：不在 open 状态下的链路，不该再算「安静」。
   */
  private beat(): void {
    if (!this.pc) return
    const endpoint = getEndpoint()
    if (!endpoint) return
    if (!endpoint.ping()) return
    this.lastPingAt = Date.now()
  }

  /* ───────────────────────────── 采样 ───────────────────────────── */

  private async sample(): Promise<void> {
    const pc = this.pc
    if (!pc || this.sampling) return
    this.sampling = true
    let sample: RtcSample
    try {
      sample = summarizeRtcStats(statsEntries(await pc.getStats()))
    } catch (err) {
      this.sampling = false
      // 采样期间链路可能已经换了：旧链路的读取结果不该写进新链路的视图
      if (this.pc !== pc) return
      this.setState({ ...this.getSnapshot(), error: messageOf(err) })
      return
    }
    this.sampling = false
    if (this.pc !== pc) return

    const now = Date.now()
    const prev = this.getSnapshot()
    const counter = rxCounterOf(sample)
    let lastRxAt = prev.lastRxAt
    if (counter != null && (this.lastCounter == null || counter > this.lastCounter)) {
      // 收到东西 = 链路还活着：显示用的时刻与判失联的基准一起推后
      this.lastCounter = counter
      this.baselineAt = now
      lastRxAt = now
    }
    // 没有接收计数 = 没有判据（不是「安静」）
    const silentMs = counter == null ? null : now - this.baselineAt
    const stalled = prev.stalled || this.judgeStall(counter, now)

    this.setState({
      attached: true,
      path: sample.path,
      localType: sample.localType,
      remoteType: sample.remoteType,
      protocol: sample.protocol,
      rttMs: sample.rttMs,
      bytesSent: sample.bytesSent,
      bytesReceived: sample.bytesReceived,
      messagesSent: sample.messagesSent,
      messagesReceived: sample.messagesReceived,
      bufferedAmount: this.bufferedAmount(),
      since: prev.since,
      sampledAt: now,
      lastRxAt,
      silentMs,
      stalled,
      // 这一轮读到了数据 → 上一次的读取失败作废（免得面板一直挂着旧报错）
      error: undefined,
    })

    if (stalled && !prev.stalled) {
      const silent = silentMs ?? LINK_STALL_MS
      for (const handler of [...this.stallHandlers]) handler(silent)
    }
  }

  /**
   * 判定失联 —— 只有「发过心跳、且心跳之后一次字节都没回来、且已经超过阈值」才成立。
   *
   * ⚠️ 三条早退都是刻意的（见文件头「三条安全阀」）：拿到 `true` 的代价是**重建一条链路**，
   * 误判会让用户在好端端的链路上被反复踢回「正在重连」。
   */
  private judgeStall(counter: number | null, now: number): boolean {
    if (counter == null) return false
    if (!this.lastPingAt) return false
    // 心跳之后已经收到过东西 → 链路是活的
    if (this.lastPingAt < this.baselineAt) return false
    return now - this.baselineAt >= LINK_STALL_MS
  }

  /**
   * 回到前台时重置基准。
   *
   * 手机切后台 / 锁屏时网页被挂起，计时器**不走** —— 回来那一刻「安静时长」会瞬间变成几分钟，
   * 于是每次切回 App 都白重建一次链路。重置基准 = 给这条链路一个全新的 15 秒窗口，
   * 真死了的话它也撑不过去（下一轮心跳照样没回音）。
   *
   * ⚠️ **不动 `since`** —— 那是面板上的「已连接时长」，重置它等于把事实改掉。
   */
  private rebaseline(): void {
    if (!this.pc) return
    const now = Date.now()
    this.lastCounter = null
    this.lastPingAt = 0
    this.baselineAt = now
    const prev = this.getSnapshot()
    this.setState({
      ...prev,
      lastRxAt: prev.lastRxAt == null ? null : now,
      silentMs: 0,
      stalled: false,
    })
  }

  private bufferedAmount(): number {
    try {
      const value = this.probe.bufferedAmount?.()
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    } catch {
      return 0
    }
  }
}

/** 监听「页面回到前台」（SSR / 测试环境没有 document 时退化为永不触发）。 */
function watchBecomeVisible(handler: () => void): () => void {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
    return () => {}
  }
  const listener = (): void => {
    if (!document.hidden) handler()
  }
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const linkStore = new LinkMonitor()
