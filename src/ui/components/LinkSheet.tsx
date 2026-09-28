/**
 * LinkSheet —— 通讯状态面板（底部抽屉）。
 *
 * 打开它的动机几乎总是同一个：**「现在手机上操作很慢 / 刚才是不是断过」**。
 * 所以第一眼必须回答三件事，其余都是补充：
 *  1. 现在连不连得上（`connectionStore.link`）；
 *  2. 走的是 **P2P 直连**还是 **TURN 中继**（走中继意味着每个字节都要过服务器 —— 卡的第一嫌疑）；
 *  3. 链路安静了多久（「静的死」的唯一可见痕迹）。
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
  type SignalTone,
} from '../../lib/rtc-stats'
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
                disabled={conn.status !== 'online'}
                onClick={() => connectionStore.reconnectNow()}
              >
                立即重连
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
