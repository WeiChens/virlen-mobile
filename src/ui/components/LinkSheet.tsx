/**
 * LinkSheet —— 通讯状态面板（底部抽屉）。
 *
 * 打开它的动机几乎总是同一个：**「现在手机上操作很慢 / 刚才是不是断过」**。
 * 所以第一眼必须回答三件事，其余都是补充：
 *  1. 现在连不连得上（`connectionStore.link`）；
 *  2. 走的是 **P2P 直连**还是 **TURN 中继**（走中继意味着每个字节都要过服务器 —— 卡的第一嫌疑）；
 *  3. 链路安静了多久（「静的死」的唯一可见痕迹）。
 *
 * §33 起多回答一件：**传输档位**（直连发完整 / 中继与类型未知只发主要内容）—— 用户看到
 * 工具卡片上写着「已省略」时，这里是唯一能解释「为什么」的地方。
 *
 * ## 数据从哪来（这里没有一样是猜的）
 *
 * - `linkStore`：本机 `getStats()` 采样出来的候选对 / 延迟 / 收发字节，**每 2 秒刷新**；
 * - `connectionStore`：链路状态与重连进度（那才是「断没断」的权威）；
 * - `api/ice.ts` 的 `lastIceResolution()`：本次实际用的 ICE 从哪来、有几台。
 *
 * ⚠️ 面板上显示的是**最近一次采样**的值：链路一断，`linkStore` 会立刻清空（`detach()`），
 * 所以断链后看到的是「—」而不是上一次的残值 —— 这正是想要的，别改成「保留最后一次」。
 *
 * 手机屏上这一层与 `SessionInfoSheet` 同形（同一套 `.sheet*` 外壳样式，见下面的 import）：
 * 两者都是「从底部升起的一层信息」，长得不一样只会让人多学一次。
 */
import type { ReactNode } from 'react'
import { useStore } from '../../lib/store'
import { usePending } from '../../lib/pending'
import { connectionStore } from '../../store/connection'
import { linkStore } from '../../store/link'
import { lastIceResolution } from '../../api/ice'
import {
  candidateText,
  formatBytes,
  formatElapsed,
  formatRtt,
  pathHint,
  pathText,
  signalTone,
  tierHint,
  tierOf,
  tierText,
  type SignalTone,
} from '../../lib/rtc-stats'
import { MESSAGE_DETAIL_CAPABILITY, type TransferTier } from 'virlen-remote'
import { IconClose } from './icons'
import './LinkSheet.css'
// `.sheet*` 是全局 CSS（不是 CSS Module）：抽屉外壳与 SessionInfoSheet 共用一份，改一处两处一起变
import './SessionInfoSheet.css'

/** 面板视觉状态（档位定义在 `lib/rtc-stats.ts`，与顶栏那枚信号图标共用同一份）。 */
type Tone = SignalTone

export default function LinkSheet({ onClose }: { onClose: () => void }) {
  const link = useStore(linkStore)
  const conn = useStore(connectionStore)
  const ice = lastIceResolution()

  const connected = conn.link === 'open'
  /**
   * 「立即重连」自己的在途态（点击到 `connect()` 有结论）—— 慢（>100ms）才显示转圈。
   *
   * 为何不只看 store：`reconnectNow()` 是异步的，而状态机要等它真正开跑才翻到
   * `connecting` —— 中间那一小段若什么都不变，就会看到「点了没反应」。
   */
  const { pending, busy, run } = usePending<'reconnect'>()
  /*
   * 「重连这件事正在跑」——两路都算：
   * - 本机点下去的那一次（`pending`，**慢才显示**：网好时不该闪）；
   * - 状态机自己那一侧（`connecting` / 自动重连等待期）—— 它们是秒级的，不必也不该延时。
   * 漏掉任何一种，按钮都会在中间那一段变回可点、文案变回「立即重连」，看着就像上一次没生效。
   */
  const linkBusy = conn.status === 'connecting' || conn.reconnecting !== undefined
  const reconnectBusy = pending === 'reconnect' || linkBusy

  const reconnect = () => {
    run('reconnect', () => connectionStore.reconnectNow())
  }
  // 按钮与面板同一份档位判定（`signalTone`）：两处各写一遍只会变成两种颜色
  const tone: Tone = signalTone(conn.link, link.path)

  const stateText = connected
    ? link.path === 'relay'
      ? '已连接 · TURN 中继'
      : link.path === 'direct'
        ? '已连接 · P2P 直连'
        : '已连接（通道类型未知）'
    : conn.link === 'connecting'
      ? '链路中断，正在尝试恢复…'
      : conn.reconnecting
        ? `已断开，正在重连（第 ${conn.reconnecting.attempt}/${conn.reconnecting.total} 次）…`
        : '已断开'

  const stateHint = connected
    ? pathHint(link.path)
    : conn.link === 'connecting'
      ? '浏览器可能只是短暂抖动（换网 / ICE 重新提名）。超过 8 秒没恢复，就会按断线重连。'
      : conn.reconnecting
        ? '重连由本机发起，用的是手机里存的授权凭证 —— 不需要你去电脑前重新出码。'
        : '链路已断开，正在等待重连或由你手动发起。'

  // 本次链路持续了多久（面板每 2 秒随采样重渲染，直接算即可，不必再养一个计时器）
  const uptime = link.since ? Date.now() - link.since : null

  /*
   * 传输档位（§33）：档位由**本机判定的链路类型**推出（口径在共享包），
   * 但「是否真的在精简」还看**电脑端支不支持** —— 它在 `hello` 应答的能力集里
   * 列出 `message.detail` 才算支持。两个事实分开取，才能拼出一句不自相矛盾的话。
   *
   * ⚠️ 面板上要显示的是**生效档位**（两者兼得才算精简），不是「打算怎么发」：
   * 电脑端太旧时摆一个「精简」、下面又写「照常全量下发」，用户只能认为界面坏了。
   * 算法与电脑端的 `effectiveTier` 是一对（各自只知道自己那一半事实）。
   */
  const tier = tierOf(link.path)
  const hostSupportsTier = conn.capabilities.includes(MESSAGE_DETAIL_CAPABILITY)
  const effectiveTier: TransferTier = hostSupportsTier ? tier : 'full'

  return (
    <>
      <div className="sheet__backdrop" onClick={onClose} />
      <section className="sheet" role="dialog" aria-label="通讯状态">
        <header className="sheet__head">
          <span className="sheet__title">通讯状态</span>
          <button type="button" className="sheet__close" aria-label="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        <div className="sheet__body">
          <div className={`link__state link__state--${tone}`}>
            <span className="link__state-dot" aria-hidden="true" />
            <span className="link__state-text">{stateText}</span>
          </div>
          <p className="sheet__hint">{stateHint}</p>

          {!link.attached && (
            <p className="sheet__hint">
              本次链路不是 WebRTC（同源 Broadcast 联调，或测试注入的链路）—— 没有候选对可读，
              「直连 / 中继」无从判断。
            </p>
          )}

          {link.attached && (
            <Block title="连接方式">
              <Row label="通道" value={pathText(link.path)} />
              <Row
                label="本端地址"
                value={`${candidateText(link.localType)}${link.protocol ? ` · ${link.protocol.toUpperCase()}` : ''}`}
              />
              <Row label="对端地址" value={candidateText(link.remoteType)} />
              <Row label="往返延迟" value={formatRtt(link.rttMs)} />
              <p className="sheet__hint">
                「走不走中继」只看当前选中的那一条候选对：任一端是 TURN 服务器就是中继。
                它会变 —— 刚打通时可能先走中继，打洞成功后就换成直连。
              </p>
            </Block>
          )}

          {/*
            传输档位：它回答的是「为什么手机上工具输出是空的」——紧跟在「连接方式」后面，
            因为档位就是由连接方式推出来的（用户在同一个区块里就能把因果读完）。
            没连上时不摆（那时档位无意义）；面板不猜：文案全在 `tierHint` 里。
          */}
          {connected && (
            <Block title="传输档位">
              <Row label="档位" value={tierText(effectiveTier)} />
              <p className="sheet__hint">{tierHint(effectiveTier, hostSupportsTier)}</p>
            </Block>
          )}

          {link.attached && (
            <Block title="数据（本次连接）">
              <Row label="已发送" value={trafficLine(link.bytesSent, link.messagesSent)} />
              <Row label="已接收" value={trafficLine(link.bytesReceived, link.messagesReceived)} />
              <Row
                label="待发积压"
                value={link.bufferedAmount > 0 ? formatBytes(link.bufferedAmount) : '0 B'}
              />
              <Row
                label="链路安静"
                value={
                  link.silentMs == null
                    ? '—（本机读不到接收计数）'
                    : `${formatElapsed(link.silentMs)}${link.stalled ? ' · 已判定失联' : ''}`
                }
              />
              <Row label="已连接" value={formatElapsed(uptime)} />
              <p className="sheet__hint">
                每 2 秒采样一次、每 5 秒发一个协议层心跳（电脑端会自动回 pong）。
                只有「心跳发出去之后连续 15 秒一个字节都没回来」才判失联 —— 空闲本来就没流量，
                所以不能只看「安静」。本机若读不到字节计数，就不会做这个判定。
              </p>
            </Block>
          )}

          <Block title="ICE 配置">
            {ice ? (
              <>
                <Row label="来源" value={ice.detail} />
                <Row label="服务器" value={iceServersLine(ice.servers)} />
                {ice.warning && <Row label="注意" value={ice.warning} warn />}
                {ice.customError && <Row label="自定义配置" value={ice.customError} warn />}
              </>
            ) : (
              <p className="sheet__hint">
                还没有解析过 ICE 配置（本次可能是同源 Broadcast 联调，或连接前就被打断了）。
              </p>
            )}
          </Block>

          <Block title="重连">
            <Row
              label="自动重连"
              value={
                conn.reconnecting
                  ? `第 ${conn.reconnecting.attempt}/${conn.reconnecting.total} 次`
                  : '未在进行'
              }
            />
            <Row label="重试上限" value="3 次（用尽后自动退回登录页）" />
            <Row label="最近采样" value={link.sampledAt ? new Date(link.sampledAt).toLocaleTimeString() : '—'} />
            <div className="link__actions">
              <button
                type="button"
                className="btn btn--small"
                disabled={conn.status !== 'online' || busy || linkBusy}
                aria-busy={busy || linkBusy}
                onClick={reconnect}
              >
                {/* 重连要跑信令 + ICE + 握手，手机上好几秒 —— 按钮自己得说「在跑」 */}
                {reconnectBusy && <span className="spinner spinner--sm" aria-hidden="true" />}
                {reconnectBusy ? '重连中…' : '立即重连'}
              </button>
              <button
                type="button"
                className="btn btn--small btn--ghost"
                onClick={() => {
                  connectionStore.disconnect()
                  onClose()
                }}
              >
                断开并返回登录页
              </button>
            </div>
            <p className="sheet__hint">
              断开只清掉这条链路，手机里存的授权凭证不动 —— 回登录页点「连接」就能重来，不必重新扫码。
            </p>
          </Block>

          {link.error && <p className="sheet__hint link__warn">读取链路数据失败：{link.error}</p>}
        </div>
      </section>
    </>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sheet__block">
      <h3 className="sheet__block-title">{title}</h3>
      {children}
    </section>
  )
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="sheet__row">
      <span className="sheet__row-label">{label}</span>
      <span className={`link__value${warn ? ' link__value--warn' : ''}`}>{value}</span>
    </div>
  )
}

/** 「1.2 MB · 34 条消息」；字节读不到就退回条数，两个都读不到才是「—」。 */
function trafficLine(bytes: number | null, messages: number | null): string {
  if (bytes == null && messages == null) return '—'
  const parts: string[] = []
  if (bytes != null) parts.push(formatBytes(bytes))
  if (messages != null) parts.push(`${messages} 条消息`)
  return parts.join(' · ')
}

/** ICE 服务器数量摘要（STUN / TURN 分开数，TURN 才是能救回对称 NAT 的那个）。 */
function iceServersLine(servers: Array<{ urls: string | string[] }>): string {
  const urls = servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
  if (urls.length === 0) return '无（只用本机候选，同网段可用）'
  const stun = urls.filter((u) => u.startsWith('stun')).length
  const turn = urls.filter((u) => u.startsWith('turn')).length
  const parts: string[] = []
  if (stun) parts.push(`STUN ${stun} 台`)
  if (turn) parts.push(`TURN ${turn} 台`)
  return `${parts.join(' · ') || `${urls.length} 台`}`
}
