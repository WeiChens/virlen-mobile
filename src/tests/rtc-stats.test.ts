/**
 * 链路体检（`lib/rtc-stats.ts`）—— 纯函数口径。
 *
 * 为什么这些断言值得写：**真机上的 WebRTC 跑不进 CI**，而「这条链路到底走没走中继」
 * 恰恰是用户看得见、又最容易说反的一件事（说反了会让人去查错方向：
 * 明明是打洞成功却说在走服务器，或者反过来把中继当直连去怀疑别处）。
 * 所以口径必须用假 stats 钉死。判定的**唯一实现**在共享包 `virlen-remote` 的 `classifyLinkKind`
 * （电脑端与手机端共用同一份）。本文件断言 `summarizeRtcStats` 的 `path` 与它一致 ——
 * 这也是防止有人又把判定抄回本端的守卫。
 */
import { describe, expect, it } from 'vitest'
import { classifyLinkKind, transferTierOf } from 'virlen-remote'
import {
  candidateText,
  formatBytes,
  formatElapsed,
  formatRtt,
  pathHint,
  pathText,
  rxCounterOf,
  signalTone,
  statsEntries,
  summarizeRtcStats,
  tierHint,
  tierOf,
  tierText,
  type RtcSample,
} from '../lib/rtc-stats'

/** 造一条候选对记录（`state` 默认 succeeded）。 */
function pair(id: string, localId: string, remoteId: string, extra: Record<string, unknown> = {}) {
  return { type: 'candidate-pair', id, localCandidateId: localId, remoteCandidateId: remoteId, state: 'succeeded', ...extra }
}

function candidate(id: string, side: 'local' | 'remote', candidateType: string, extra: Record<string, unknown> = {}) {
  return { id, type: side === 'local' ? 'local-candidate' : 'remote-candidate', candidateType, ...extra }
}

/** 数据通道统计（现代实现给的是 `data-channel`）。 */
function dataChannel(extra: Record<string, unknown> = {}) {
  return { type: 'data-channel', id: 'DC0', ...extra }
}

/** 一条「本端 srflx ↔ 对端 host」的直连链路（打洞成功）。 */
const DIRECT = [
  { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
  pair('P0', 'L0', 'R0', { currentRoundTripTime: 0.042, protocol: 'udp', responsesReceived: 9 }),
  candidate('L0', 'local', 'srflx', { protocol: 'udp' }),
  candidate('R0', 'remote', 'host'),
  dataChannel({ bytesSent: 2048, bytesReceived: 4096, messagesSent: 12, messagesReceived: 30 }),
]

/** 同一条链路，但对端是中继（字节确实过了 TURN 服务器）。 */
const RELAY = [
  { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
  pair('P0', 'L0', 'R0', { currentRoundTripTime: 0.21, protocol: 'udp' }),
  candidate('L0', 'local', 'host'),
  candidate('R0', 'remote', 'relay'),
]

describe('summarizeRtcStats —— 直连 / 中继的判定', () => {
  it('标准路径：transport.selectedCandidatePairId 指出哪条候选对在用', () => {
    const s = summarizeRtcStats(DIRECT)
    expect(s.path).toBe('direct')
    expect(s.localType).toBe('srflx')
    expect(s.remoteType).toBe('host')
    // `currentRoundTripTime` 的单位是秒，面板要 ms
    expect(s.rttMs).toBeCloseTo(42)
    expect(s.protocol).toBe('udp')
  })

  it('任一端是 relay 就是中继（本端 relay / 对端 relay / 两端都 relay）', () => {
    expect(summarizeRtcStats(RELAY).path).toBe('relay')
    expect(
      summarizeRtcStats([
        { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
        pair('P0', 'L0', 'R0'),
        candidate('L0', 'local', 'relay'),
        candidate('R0', 'remote', 'host'),
      ]).path,
    ).toBe('relay')
    expect(
      summarizeRtcStats([
        { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
        pair('P0', 'L0', 'R0'),
        candidate('L0', 'local', 'relay'),
        candidate('R0', 'remote', 'relay'),
      ]).path,
    ).toBe('relay')
  })

  it('本端 / 对端都用 host（同网段）或 prflx 也算直连', () => {
    expect(
      summarizeRtcStats([
        { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
        pair('P0', 'L0', 'R0'),
        candidate('L0', 'local', 'host'),
        candidate('R0', 'remote', 'prflx'),
      ]).path,
    ).toBe('direct')
  })

  it('没有 transport 记录时退到「nominated + succeeded」，再退到任意 succeeded', () => {
    expect(
      summarizeRtcStats([pair('P0', 'L0', 'R0', { nominated: true }), candidate('L0', 'local', 'host'), candidate('R0', 'remote', 'host')])
        .path,
    ).toBe('direct')
    // 老实现既不给 transport 也不给 nominated → 取第一条 succeeded（不能因此显示未知）
    expect(
      summarizeRtcStats([pair('P9', 'L0', 'R0'), candidate('L0', 'local', 'host'), candidate('R0', 'remote', 'host')]).path,
    ).toBe('direct')
  })

  it('候选对还没定型（in-progress / failed）→ unknown：此刻「怎么连的」还没确定', () => {
    expect(
      summarizeRtcStats([
        { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
        pair('P0', 'L0', 'R0', { state: 'in-progress' }),
        candidate('L0', 'local', 'relay'),
        candidate('R0', 'remote', 'relay'),
      ]).path,
    ).toBe('unknown')
  })

  it('一条候选对都没有（数据通道刚开）→ unknown，绝不猜成直连', () => {
    const s = summarizeRtcStats([dataChannel({ bytesSent: 10, bytesReceived: 20 })])
    expect(s.path).toBe('unknown')
    expect(s.localType).toBeNull()
    expect(s.remoteType).toBeNull()
    // 数据通道的计数照样要读出来（保活判定靠它）
    expect(s.bytesReceived).toBe(20)
  })

  it('认 2014 版规范的老类型名（localcandidate / remotecandidate）', () => {
    const s = summarizeRtcStats([
      { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
      pair('P0', 'L0', 'R0'),
      { id: 'L0', type: 'localcandidate', candidateType: 'host' },
      { id: 'R0', type: 'remotecandidate', candidateType: 'relay' },
    ])
    expect(s.path).toBe('relay')
    expect(s.remoteType).toBe('relay')
  })

  it('字段缺失一律给 null（不是 0、不是 NaN）——面板据此显示「—」而不是假数字', () => {
    const s = summarizeRtcStats([
      { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
      pair('P0', 'L0', 'R0'),
      candidate('L0', 'local', 'host'),
      candidate('R0', 'remote', 'host'),
    ])
    expect(s.rttMs).toBeNull()
    expect(s.bytesSent).toBeNull()
    expect(s.bytesReceived).toBeNull()
    expect(s.messagesSent).toBeNull()
    expect(s.consentResponses).toBeNull()
  })

  it('坏数据不影响判定（null / 字符串 / 数字混进来也不抛）', () => {
    const s = summarizeRtcStats([
      null,
      'nonsense',
      42,
      { type: 'candidate-pair', id: 'P0', localCandidateId: 7, remoteCandidateId: null, state: 'succeeded' },
    ])
    expect(s.path).toBe('unknown')
    expect(s.localType).toBeNull()
  })
})

describe('statsEntries —— 报表摊平', () => {
  it('forEach 出来的东西照单全收，非对象的条目丢掉', () => {
    const report = { forEach: (cb: (entry: unknown) => void) => [1, { type: 'transport' }, null].forEach(cb) }
    expect(statsEntries(report)).toHaveLength(1)
  })

  it('没有报表 / 没有 forEach → 空数组（不是抛错）', () => {
    expect(statsEntries(null)).toEqual([])
    expect(statsEntries(undefined)).toEqual([])
    expect(statsEntries({} as { forEach: (cb: (entry: unknown) => void) => void })).toEqual([])
  })
})

describe('rxCounterOf —— 失联判定的判据', () => {
  const base: RtcSample = {
    path: 'direct',
    localType: 'host',
    remoteType: 'host',
    protocol: 'udp',
    rttMs: 10,
    bytesSent: 0,
    bytesReceived: null,
    messagesSent: 0,
    messagesReceived: null,
    consentResponses: 0,
  }

  it('优先用接收字节数，其次是消息条数', () => {
    expect(rxCounterOf({ ...base, bytesReceived: 100, messagesReceived: 5 })).toBe(100)
    expect(rxCounterOf({ ...base, messagesReceived: 5 })).toBe(5)
  })

  it('两者都读不到 → null（= 本机没有判据，绝不据此判失联）', () => {
    expect(rxCounterOf(base)).toBeNull()
  })

  it('不拿 ICE 保活应答当判据（空闲链路上它涨不涨，各实现并不一致）', () => {
    expect(rxCounterOf({ ...base, consentResponses: 99 })).toBeNull()
  })
})

describe('signalTone —— 图标与面板共用同一份档位', () => {
  it('已连接：直连=good、中继=relay、类型未知=plain', () => {
    expect(signalTone('open', 'direct')).toBe('good')
    expect(signalTone('open', 'relay')).toBe('relay')
    expect(signalTone('open', 'unknown')).toBe('plain')
  })

  it('未连接：connecting=warn，closed=down（与通道类型无关）', () => {
    expect(signalTone('connecting', 'direct')).toBe('warn')
    expect(signalTone('closed', 'direct')).toBe('down')
    expect(signalTone('closed', 'unknown')).toBe('down')
  })
})

describe('展示辅助', () => {
  it('通道类型 / 候选类型都给人话，读不到就说「未知」', () => {
    expect(pathText('direct')).toBe('P2P 直连')
    expect(pathText('relay')).toBe('TURN 中继')
    expect(pathText('unknown')).toBe('未知')
    expect(pathHint('relay')).toContain('TURN')
    expect(candidateText('srflx')).toContain('STUN')
    expect(candidateText('relay')).toContain('TURN')
    expect(candidateText(null)).toBe('未知')
  })

  it('字节数：B / KB / MB，读不到给「—」', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB')
    expect(formatBytes(null)).toBe('—')
  })

  it('时长：秒 / 分秒 / 小时分', () => {
    expect(formatElapsed(9000)).toBe('9 秒')
    expect(formatElapsed(65_000)).toBe('1 分 5 秒')
    expect(formatElapsed(3 * 3600_000 + 120_000)).toBe('3 小时 2 分')
    expect(formatElapsed(null)).toBe('—')
  })

  it('延迟带观感提示（用户看不懂 42ms 是好是坏）', () => {
    expect(formatRtt(42)).toBe('42 ms （很好）')
    expect(formatRtt(150)).toContain('一般')
    expect(formatRtt(600)).toContain('偏慢')
    expect(formatRtt(null)).toBe('—')
  })
})

describe('判定委托给共享包 —— 本端不再自己判「直连 / 中继」', () => {
  it('summarizeRtcStats().path 与共享包 classifyLinkKind() 完全一致', () => {
    for (const stats of [DIRECT, RELAY]) {
      expect(summarizeRtcStats(stats).path).toBe(classifyLinkKind(stats))
    }
    expect(summarizeRtcStats([]).path).toBe(classifyLinkKind([]))
  })
})

describe('§33 传输档位的展示文案 —— 「为什么工具输出是空的」只有这里能拼对', () => {
  it('tierOf 与共享包 transferTierOf 完全一致（防止有人又把映射抄回本端）', () => {
    for (const path of ['direct', 'relay', 'unknown'] as const) {
      expect(tierOf(path)).toBe(transferTierOf(path))
    }
  })

  it('档位文案直说「会发什么」，不摆术语', () => {
    expect(tierText('lean')).toContain('只传主要内容')
    expect(tierText('full')).toContain('含工具输出')
  })

  it('精简档：说清「中继 / 未判定才这样」+「工具输出不下发」+「怎么拿回全文」', () => {
    const hint = tierHint('lean', true)
    expect(hint).toContain('TURN 中继')
    expect(hint).toContain('输出正文不下发')
    expect(hint).toContain('重开会话')
  })

  it('直连档：明说「不省任何东西」（用户不必担心少看了什么）', () => {
    expect(tierHint('full', true)).toContain('完整下发')
  })

  it('电脑端不支持档位时**不能说**「精简」（那台电脑端其实一个字节都没省）', () => {
    const hint = tierHint('full', false)
    expect(hint).toContain('不支持传输档位')
    expect(hint).toContain('照常下发')
  })
})
