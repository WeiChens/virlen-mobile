/**
 * RTC 链路体检 —— 从 `RTCPeerConnection.getStats()` 读出「这条链路长什么样」。
 *
 * ## 为什么要手机端自己读
 *
 * 协议表里有 `host.event.connection.changed`（电脑端在链路类型**确定**时下发），但手机端不拿它
 * 当唯一来源：本端同样有一条所选候选对，「字节有没有过 TURN」在本端也成立。自己读既能在事件
 * 尚未到达时就有结论，也能在事件到达后**交叉校验电脑视角**（对不上 = 有一端的 stats 读取有问题）。
 *
 * ## 判定口径已收敛到共享包
 *
 * 「直连 / 中继」的判定**不在本文件里了** —— 它搬进了 `virlen-remote` 的 `classifyLinkKind`
 * （电脑端 `virlen-app/src/bridge/link-kind.ts` 与手机端都引用同一份）。此前两端各持一份副本，
 * 存在「手机说 P2P、电脑说中继」的漂移风险，现已消除。本文件只负责从**同一份** stats 里多读几个
 * 展示字段（rtt / 字节 / 候选类型），判定直接调共享实现。
 *
 * 本文件仍是**纯函数**（喂普通对象数组即可，不需要真实 WebRTC）—— 真实 WebRTC 跑不进 CI，
 * 所以「口径」由共享包自己的单测钉死。
 *
 * §33 起它还带着「**传输档位**」的展示文案（`tierOf` / `tierText` / `tierHint`）：档位同样由
 * 链路类型推导（口径仍只一份），而「手机上工具输出为什么是空的」这句话只有在这里能拼对。
 */
import {
  classifyLinkKind,
  findCandidate,
  pickCandidatePair,
  transferTierOf,
  type LinkKind,
  type TransferTier,
} from 'virlen-remote'

/**
 * 通讯通道类型：`direct` = P2P 直连；`relay` = TURN 中继；`unknown` = 没拿到结论。
 *
 * ⚠️ 就是共享包的 `LinkKind` —— 判定口径已收敛到 `virlen-remote`（见文件头）。旧的 `LinkPath`
 * 名字保留，避免大面积改调用方。
 */
export type LinkPath = LinkKind

/** 一条 stats 记录（`RTCStatsReport` 的 value）。 */
type StatsEntry = Record<string, unknown>

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
 * 「直连 / 中继」的判定走共享包 `classifyLinkKind`（口径与电脑端同一份：所选候选对 + 候选类型）；
 * 本函数只额外从**同一条**候选对里读 rtt / 协议 / 收发计数等展示字段。
 */
export function summarizeRtcStats(entries: Iterable<unknown>): RtcSample {
  const list = [...entries].filter((e): e is StatsEntry => !!e && typeof e === 'object')
  const pair = pickCandidatePair(list)
  const dc = list.find((s) => s['type'] === 'data-channel')
  const local = findCandidate(list, pair?.['localCandidateId'], 'local')
  const remote = findCandidate(list, pair?.['remoteCandidateId'], 'remote')

  // 判定走共享包；候选对 / 候选记录也用共享包的挑选，保证判定与显示取自**同一条**候选对
  const path = classifyLinkKind(list)
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

/** 取值：非空字符串 / 有限数字，否则 `null`（面板不显示 `undefined`）。 */
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

/* ────────────────────────── 传输档位（§33）────────────────────────── */

/**
 * 通道类型 → **传输档位**（`full` 完整 / `lean` 精简）。
 *
 * 口径在共享包（`transferTierOf`，电脑端也读同一份），本函数只是把它转出给 UI ——
 * 于是「手机面板写精简、电脑按完整发」这种自相矛盾在类型层就无处可藏。
 */
export function tierOf(path: LinkPath): TransferTier {
  return transferTierOf(path)
}

/** 档位 → 短文案（面板上「档位」那一行）。 */
export function tierText(tier: TransferTier): string {
  return tier === 'lean' ? '精简（只传主要内容）' : '完整（含工具输出）'
}

/**
 * 档位 → 一句解释（面板里那句「工具输出为什么是空的」）。
 *
 * `hostSupports` = 电脑端在 `hello` 应答的能力集里列出了 `message.detail`（= 它支持按档位裁剪）。
 * 为 `false` 时**不能说「已精简」** —— 那台电脑端会把全部内容照常发下来（它根本没裁剪），
 * 只是本端面板没有别的依据；「电脑端不支持」与「真的精简了」必须分开说，不能混成一句。
 */
export function tierHint(tier: TransferTier, hostSupports: boolean): string {
  if (!hostSupports) {
    return '当前电脑端不支持传输档位（未声明 message.detail 能力）：所有内容（包括工具输出）照常下发。升级电脑端后，中继链路会自动改为只传主要内容。'
  }
  if (tier === 'lean') {
    return '本链路走 TURN 中继或通道类型未判定：只下发主要内容 —— 工具调用的输出正文不下发（省的是手机流量），工具卡片上会标「已省略」。切回直连后重开会话可拉取全文。'
  }
  return '本链路为 P2P 直连：正文与工具输出都完整下发，不省任何东西。'
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
