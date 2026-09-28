/**
 * RTC 链路体检 —— 从 `RTCPeerConnection.getStats()` 读出「这条链路长什么样」。
 *
 * ## 为什么要手机端自己读
 *
 * 协议的方法表里**确实有** `host.event.connection.changed: { path: 'direct' | 'relay' }`，
 * 但电脑端目前**从不发它**（`virlen-app/src/bridge/link-kind.ts` 算出来的结论只喂给了桌面设置页）。
 * 而「字节有没有过 TURN」这件事在本端同样成立 —— 本端也有一条所选候选对。所以这里自己读，
 * 不依赖一个尚未落地的协议事件（等到电脑端真发它那天，可以拿它做交叉校验，但不能拿它当唯一来源）。
 *
 * ⚠️ **判定口径必须与电脑端 `link-kind.ts` 一致**（同一条候选对 + 同一套候选类型），
 * 否则会出现「手机说 P2P、电脑说中继」这种两台设备互相打脸的状态。
 * 那个文件在另一个仓库（virlen-app）里，本文件是它的**副本**；将来它若搬进共享包，这份删掉。
 *
 * 本文件是**纯函数**（喂普通对象数组即可，不需要真实 WebRTC）—— 真实 WebRTC 跑不进 CI，
 * 所以「口径」必须能用假数据钉死。
 */

/** 通讯通道类型：`direct` = P2P 直连；`relay` = TURN 中继；`unknown` = 没拿到结论。 */
export type LinkPath = 'direct' | 'relay' | 'unknown'

/** 一条 stats 记录（`RTCStatsReport` 的 value）。 */
type StatsEntry = Record<string, unknown>

/**
 * 直连的候选类型：
 * - `host`：本机地址（同网段，最快）；
 * - `srflx`：经 STUN 得到的公网映射（打洞成功）；
 * - `prflx`：对端反射（对方的 STUN 让我们发现的地址）。
 */
const DIRECT_TYPES = ['host', 'srflx', 'prflx']

/** 候选类型 → 人话（面板里显示，用户看不懂 `srflx` 这几个字母）。 */
const CANDIDATE_TEXT: Record<string, string> = {
  host: '本机地址（同网段）',
  srflx: 'STUN 打洞（公网映射）',
  prflx: '对端反射地址',
  relay: 'TURN 中继服务器',
}

/** 一次体检结果（全部字段都可能为 `null` = 本机 / 当下读不到）。 */
export interface RtcSample {
  path: LinkPath
  /** 本端 / 对端候选类型（`host` / `srflx` / `prflx` / `relay`）。 */
  localType: string | null
  remoteType: string | null
  /** 传输协议（`udp` / `tcp`）。 */
  protocol: string | null
  /** 所选候选对的往返时延（ms）。 */
  rttMs: number | null
  /** 数据通道累计收发。 */
  bytesSent: number | null
  bytesReceived: number | null
  messagesSent: number | null
  messagesReceived: number | null
  /** ICE 保活应答数（`candidate-pair.responsesReceived`），只作参考显示。 */
  consentResponses: number | null
}

/** 读不到任何东西时的样本（链路还没建好 / 环境不支持）。 */
export const EMPTY_SAMPLE: RtcSample = {
  path: 'unknown',
  localType: null,
  remoteType: null,
  protocol: null,
  rttMs: null,
  bytesSent: null,
  bytesReceived: null,
  messagesSent: null,
  messagesReceived: null,
  consentResponses: null,
}

/** `RTCStatsReport` 的最小形状（测试可喂假对象）。 */
export interface StatsReportLike {
  forEach(callback: (entry: unknown) => void): void
}

/**
 * 把 `getStats()` 的报表摊成数组。
 *
 * 单独抽出来是因为 `RTCStatsReport` 既是 Map 又只有 `forEach` 一种遍历方式 ——
 * 摊开一次，后面的纯函数就只认数组。
 */
export function statsEntries(report: StatsReportLike | null | undefined): StatsEntry[] {
  const list: StatsEntry[] = []
  if (!report || typeof report.forEach !== 'function') return list
  report.forEach((entry) => {
    if (entry && typeof entry === 'object') list.push(entry as StatsEntry)
  })
  return list
}

/**
 * 体检一次。
 *
 * 顺序刻意如此（与电脑端同一份）：
 *  1. `transport.selectedCandidatePairId` —— 规范里**明确**指出「正在用哪条候选对」，最可信；
 *  2. 退而求其次：`nominated` 且 `succeeded` 的候选对（老实现不给 `transport` 记录）；
 *  3. 再退：任意 `succeeded` 的候选对；
 *  4. 都没有 → `unknown`（**不猜**：宁可不显示，也不能把中继说成直连）。
 */
export function summarizeRtcStats(entries: Iterable<unknown>): RtcSample {
  const list = [...entries].filter((e): e is StatsEntry => !!e && typeof e === 'object')
  const pair = selectedPair(list) ?? succeededPair(list)
  const dc = list.find((s) => s['type'] === 'data-channel')
  const local = candidateOf(list, pair?.['localCandidateId'], 'local')
  const remote = candidateOf(list, pair?.['remoteCandidateId'], 'remote')

  const path = classifyPath(pair, local, remote)
  // `currentRoundTripTime` 的单位是**秒**，面板上要 ms
  const rttSec = num(pair?.['currentRoundTripTime'])

  return {
    path,
    localType: str(local?.['candidateType']),
    remoteType: str(remote?.['candidateType']),
    protocol: str(local?.['protocol']) ?? str(pair?.['protocol']),
    rttMs: rttSec == null ? null : rttSec * 1000,
    bytesSent: num(dc?.['bytesSent']),
    bytesReceived: num(dc?.['bytesReceived']),
    messagesSent: num(dc?.['messagesSent']),
    messagesReceived: num(dc?.['messagesReceived']),
    consentResponses: num(pair?.['responsesReceived']),
  }
}

function classifyPath(
  pair: StatsEntry | undefined,
  local: StatsEntry | undefined,
  remote: StatsEntry | undefined,
): LinkPath {
  if (!pair) return 'unknown'
  // 还没定型的候选对（in-progress / failed）不算结论：此刻「怎么连的」还没确定
  const state = pair['state']
  if (typeof state === 'string' && state !== 'succeeded') return 'unknown'

  const types = [local?.['candidateType'], remote?.['candidateType']].filter(
    (t): t is string => typeof t === 'string',
  )
  if (types.includes('relay')) return 'relay'
  if (types.some((t) => DIRECT_TYPES.includes(t))) return 'direct'
  return 'unknown'
}

/** 标准路径：`transport` 记录里明确指出的那条候选对。 */
function selectedPair(list: StatsEntry[]): StatsEntry | undefined {
  const transport = list.find(
    (s) => s['type'] === 'transport' && typeof s['selectedCandidatePairId'] === 'string',
  )
  const id = transport?.['selectedCandidatePairId']
  if (typeof id !== 'string') return undefined
  return list.find((s) => s['type'] === 'candidate-pair' && s['id'] === id)
}

/** 兜底路径：`nominated`（已被选中的那条）+ `succeeded`；没有 nominated 就取第一条 succeeded。 */
function succeededPair(list: StatsEntry[]): StatsEntry | undefined {
  const pairs = list.filter((s) => s['type'] === 'candidate-pair' && s['state'] === 'succeeded')
  return pairs.find((p) => p['nominated'] === true) ?? pairs[0]
}

/**
 * 按 id 找候选记录。
 *
 * `localcandidate` / `remotecandidate` 是 2014 版规范里的类型名（部分实现仍在用），
 * 一起认下来 —— 认不出的代价是「明明是直连却显示未知」。
 */
function candidateOf(list: StatsEntry[], id: unknown, side: 'local' | 'remote'): StatsEntry | undefined {
  if (typeof id !== 'string') return undefined
  const kinds =
    side === 'local' ? ['local-candidate', 'localcandidate'] : ['remote-candidate', 'remotecandidate']
  return list.find((s) => s['id'] === id && kinds.includes(s['type'] as string))
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/* ─────────────────────────── 失联判定用的计数 ─────────────────────────── */

/**
 * 「从电脑收到了东西」的单调计数 —— 用来判断链路是不是还活着。
 *
 * 为什么是这两个：**只要电脑回一帧（含我们主动 ping 的 pong），它就会增长**，
 * 而链路的字节里本来就包含协议帧本身。读不到就返回 `null`（= 本机不提供这个判据），
 * 此时**绝不放行失联判定** —— 拿不到证据的时候强行判定，代价是「明明好好的链路被反复重建」。
 *
 * ⚠️ 刻意**不用** `candidate-pair.responsesReceived`（ICE 保活应答）当判据：
 * 它是否在**空闲**链路上持续增长，各实现并不一致（浏览器可能压着不发）。
 * 空闲时它不涨 → 就成了误判。它只作为面板上的参考数字显示。
 */
export function rxCounterOf(sample: RtcSample): number | null {
  return sample.bytesReceived ?? sample.messagesReceived
}

/* ───────────────────────────── 展示辅助 ───────────────────────────── */

/** 通道类型 → 人话。 */
export function pathText(path: LinkPath): string {
  if (path === 'direct') return 'P2P 直连'
  if (path === 'relay') return 'TURN 中继'
  return '未知'
}

/** 通道类型 → 一句解释（为什么用户该在意）。 */
export function pathHint(path: LinkPath): string {
  if (path === 'direct') return '手机与电脑之间直接传输，延迟最低。'
  if (path === 'relay') return '字节要经 TURN 服务器转发：能连上，但更慢、也更吃流量。'
  return '还没拿到结论（链路刚建立或正在重协商）。'
}

/**
 * 视觉档位（信号图标的颜色 / 面板首行）——把「链路状态 + 通道类型」合成一个能直接上色的值。
 *
 * 为何要抽成一个纯函数：**按钮和面板必须同色同词**。两处各写一遍 `if`，
 * 迟早会出现「图标是绿的、面板写着中继」这种自相矛盾（用户对颜色的记忆比对文字牢）。
 *
 * `linkState` 只收字面量，不收 `connectionStore` 的类型 —— `lib` 不依赖 `store`。
 */
export type SignalTone = 'good' | 'relay' | 'warn' | 'down' | 'plain'

export function signalTone(linkState: 'open' | 'connecting' | 'closed', path: LinkPath): SignalTone {
  if (linkState === 'open') {
    if (path === 'relay') return 'relay'
    if (path === 'direct') return 'good'
    return 'plain'
  }
  return linkState === 'connecting' ? 'warn' : 'down'
}

/** 候选类型 → 人话；读不到时说「未知」，不编。 */
export function candidateText(type: string | null): string {
  if (!type) return '未知'
  return CANDIDATE_TEXT[type] ?? type
}

/** 字节数 → 人话（面板里显示累计收发量）。 */
export function formatBytes(n: number | null): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

/** 时长（ms）→ 人话。 */
export function formatElapsed(ms: number | null): string {
  if (ms == null) return '—'
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分 ${sec % 60} 秒`
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`
}

/** 延迟（ms）→ 人话 + 观感提示。 */
export function formatRtt(ms: number | null): string {
  if (ms == null) return '—'
  const rounded = Math.round(ms)
  const feel = rounded < 80 ? '（很好）' : rounded < 200 ? '（一般）' : '（偏慢）'
  return `${rounded} ms ${feel}`
}
