import { useEffect, useState } from 'react'
import QrScanner from '../../components/QrScanner'
import { useStore } from '../../lib/store'
import {
  checkGrant,
  describeGrantRemaining,
  fetchHostOnlineMap,
  parsePairingPayload,
  type PairingPayload,
} from 'virlen-remote'
import { connectionStore, type ConnectErrorReason } from '../../store/connection'
import {
  MAX_DEVICE_NAME_LEN,
  deviceLabel,
  devicesStore,
  grantStateOf,
  type PairedDevice,
} from '../../store/devices'
import { customIceText, resolveIceFor, saveCustomIce } from '../../api/ice'
import './Login.css'

/**
 * 自定义 ICE 的**填写示例**（占位文本）。
 *
 * ⚠️ 这只是占位，不是默认值：默认值由电脑端所在服务下发（`GET <信令基址>/ice`，§31）。
 */
const ICE_PLACEHOLDER = `[
  { "urls": "stun:your.server:3478" },
  { "urls": "turn:your.server:3478", "username": "user", "credential": "pass" }
]`

/** 在线状态：`undefined` = 未知（旧记录没有信令基址 / 查询失败）。 */
type OnlineMap = Map<string, boolean>
/** 在线状态轮询间隔（登录页停着时）；只查一次会迅速过期，查太勤没必要。 */
const ONLINE_POLL_MS = 15_000

/** 三类「需要重新扫码」的拒因，给同一个提醒语气。 */
const RESCAN_REASONS: ConnectErrorReason[] = ['expired', 'revoked', 'ticket-expired']

function formatTime(ts: number): string {
  if (!ts) return '从未'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 「连到哪台电脑」的附带参数。
 *
 * 字段名与 `ConnectOptions` 同名同义，但不直接透传整个 `ConnectOptions` ——
 * 里面的 `transport` / `mode` 是测试与重连的内部开关，不该由页面决定。
 */
interface ConnectTarget {
  signalUrl?: string
  room?: string
  /** 现场配对（手上是一次性票据）：电脑端要等用户点确认，握手超时给到 1 分钟。 */
  pairing?: boolean
}

/** 连到指定电脑（`token` = 授权凭证；扫码时是一次性票据）。 */
function connectTo(hostKey: string, name: string, token: string, target: ConnectTarget = {}) {
  void connectionStore.connect({
    hostId: hostKey,
    deviceName: name,
    token,
    signalUrl: target.signalUrl,
    room: target.room,
    pairing: target.pairing,
  })
}

export default function Login() {
  const devices = useStore(devicesStore)
  const conn = useStore(connectionStore)
  const [scanning, setScanning] = useState(false)
  const [manual, setManual] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [online, setOnline] = useState<OnlineMap>(new Map())
  const [iceText, setIceText] = useState('')
  const [iceStatus, setIceStatus] = useState('')
  const [iceError, setIceError] = useState<string | null>(null)

  const busy = conn.status === 'connecting'

  /**
   * 查询各台电脑的在线状态（`POST /status`，**不加入房间**）。
   *
   * 依赖用「设备列表指纹」而不是 `devices` 数组本身：数组每次 store 更新都换引用，
   * 直接当依赖会让这个 effect 无限重启（每 15 秒的定时器也跟着重排）。
   */
  const devicesFingerprint = devices.map((d) => `${d.hostKey}@${d.signalUrl ?? ''}`).join('|')
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const list = devicesStore.getSnapshot().filter((d) => d.signalUrl)
      if (list.length === 0) return
      const found: OnlineMap = new Map()
      for (const url of new Set(list.map((d) => d.signalUrl!))) {
        const keys = list.filter((d) => d.signalUrl === url).map((d) => d.hostKey)
        const mapped = await fetchHostOnlineMap(url, keys)
        for (const [key, value] of mapped) found.set(key, value)
      }
      if (!cancelled) setOnline(found)
    }
    void load()
    const timer = setInterval(() => void load(), ONLINE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [devicesFingerprint])

  const handleScanned = (text: string) => {
    setScanning(false)
    const payload: PairingPayload | null = parsePairingPayload(text)
    if (!payload) {
      setParseError('无法识别该二维码（不是 Virlen 配对码）')
      return
    }
    // 手上是**一次性票据**：电脑端会弹窗等用户点确认，这一步可能停在几十秒
    connectTo(payload.host, payload.name, payload.ticket, {
      signalUrl: payload.signal,
      room: payload.room,
      pairing: true,
    })
  }

  const handleManual = () => {
    const payload = parsePairingPayload(manual.trim())
    if (!payload) {
      setParseError('配对串格式不正确')
      return
    }
    setManual('')
    // 与扫码同一条路径（同是票据，同样要等电脑端确认）
    connectTo(payload.host, payload.name, payload.ticket, {
      signalUrl: payload.signal,
      room: payload.room,
      pairing: true,
    })
  }

  /**
   * 展开「高级设置：ICE」时回填文本框 + 解析一次（状态行要有内容）。
   *
   * 解析需要一个信令基址：取第一台「带基址的已配对电脑」的 —— 与真正连接时用的是同一个服务。
   */
  const loadIce = async () => {
    setIceText(customIceText())
    const signalUrl = devices.find((d) => d.signalUrl)?.signalUrl
    const resolved = await resolveIceFor(signalUrl)
    setIceStatus(`${resolved.detail}${resolved.warning ? ` · ${resolved.warning}` : ''}`)
    setIceError(resolved.customError ?? null)
  }

  const handleSaveIce = () => {
    const result = saveCustomIce(iceText)
    // 显式比较：`{ok:true} | {ok:false}` 联合类型在真值判断下不窄化（与电脑端同一个坑）
    if (result.ok === false) {
      setIceError(result.error)
      return
    }
    void loadIce()
  }

  const handleResetIce = () => {
    saveCustomIce('')
    setIceText('')
    setIceError(null)
    void loadIce()
  }

  if (scanning) {
    return <QrScanner onResult={handleScanned} onCancel={() => setScanning(false)} />
  }

  const reason = conn.error?.reason
  const needRescan = reason != null && RESCAN_REASONS.includes(reason)

  return (
    <div className="login">
      <header className="login__head">
        <h1 className="login__title">Virlen 手机控制</h1>
        <p className="login__sub">连接你的电脑，随时查看与操作 Agent</p>
      </header>

      {conn.status === 'error' && conn.error && (
        <div className={`banner banner--${reason === 'replaced' || needRescan ? 'denied' : 'offline'}`}>
          <strong>
            {reason === 'replaced'
              ? '连接已被接管'
              : reason === 'dropped'
                ? '通讯已中断'
                : needRescan
                  ? '需要重新扫码'
                  : reason === 'denied'
                    ? '连接被拒绝'
                    : '无法连接'}
          </strong>
          <span>{conn.error.message}</span>
        </div>
      )}

      {parseError && <div className="banner banner--denied">{parseError}</div>}

      {busy && (
        <div className="login__connecting">
          <span className="spinner" />
          正在连接 {conn.targetName}…
        </div>
      )}

      <button type="button" className="btn btn--primary" disabled={busy} onClick={() => setScanning(true)}>
        扫码添加电脑
      </button>

      <section className="login__devices">
        <h2 className="login__section-title">已配对的电脑</h2>
        {devices.length === 0 && <p className="login__empty">还没有配对过的电脑，先扫码添加。</p>}
        {devices.map((d) => (
          <DeviceRow
            key={d.hostKey}
            device={d}
            busy={busy}
            online={online.get(d.hostKey)}
            onConnect={() =>
              // 已配对设备：手上是**长期凭证**，电脑端立刻应答 —— 不带 `pairing`，保持 4 秒快失败
              // 名字用 `deviceLabel`（本地改的名字优先）：连接中的提示也应该是自己起的名字
              connectTo(d.hostKey, deviceLabel(d), d.grant, { signalUrl: d.signalUrl, room: d.room })
            }
            onRemove={() => devicesStore.remove(d.hostKey)}
          />
        ))}
      </section>

      <details className="login__manual">
        <summary>手动输入配对串</summary>
        <textarea
          className="login__textarea"
          rows={3}
          placeholder='{"v":2,"host":"dk-…","name":"Virlen 电脑","ticket":"…","signal":"https://virlen.cn/api/rtc/"}'
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <button type="button" className="btn btn--small" disabled={busy || !manual.trim()} onClick={handleManual}>
          连接
        </button>
        <p className="login__tip">
          提示：二维码里的票据是一次性的、只有 5 分钟有效；配对成功后手机会拿到长期凭证，
          之后从这里直接点「连接」即可，不必再扫码。
        </p>
      </details>

      {/*
        高级设置：ICE（§31）。默认值由服务端下发，**手机端源码里不含任何 TURN 凭证**。
        需要自建 coturn / 内网 STUN / 公共 STUN 时，在这里覆盖。
      */}
      <details
        className="login__advanced"
        onToggle={(e) => {
          if ((e.target as HTMLDetailsElement).open) void loadIce()
        }}
      >
        <summary>高级设置：ICE 服务器（STUN / TURN）</summary>
        {iceStatus && <p className="login__tip">当前生效：{iceStatus}</p>}
        {iceError && <p className="login__tip login__tip--warn">自定义配置有问题：{iceError}</p>}
        <textarea
          className="login__textarea"
          rows={5}
          spellCheck={false}
          placeholder={ICE_PLACEHOLDER}
          value={iceText}
          onChange={(e) => setIceText(e.target.value)}
        />
        <div className="login__ice-actions">
          <button type="button" className="btn btn--small" onClick={handleSaveIce}>
            保存
          </button>
          <button type="button" className="btn btn--small btn--ghost" onClick={handleResetIce}>
            恢复服务端默认
          </button>
        </div>
        <p className="login__tip">
          留空 = 用电脑所在服务下发的默认值；填了就完全用你这份。改完下次连接生效
          （手机端源码里不含任何中继凭证）。
        </p>
      </details>
    </div>
  )
}

/** 一台已配对电脑：名字 · 在线状态 · 凭证有效期 · 上次连接；行内可改名。 */
function DeviceRow({
  device,
  busy,
  online,
  onConnect,
  onRemove,
}: {
  device: PairedDevice
  busy: boolean
  online: boolean | undefined
  onConnect: () => void
  onRemove: () => void
}) {
  const state = grantStateOf(device)
  const expired = state === 'expired'
  const onlineText = online === undefined ? '状态未知' : online ? '电脑在线' : '电脑不在线'
  const label = deviceLabel(device)

  /*
   * 改名做成**行内编辑**而不是 `window.prompt`：PWA 里 prompt 的文案样式不可控、
   * 在部分 iOS 内嵌浏览器里还会被拦（返回 null）—— 一个「点了没反应」的按钮
   * 比没有这个功能更糟。
   */
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const startEdit = () => {
    // 预填**当前显示的名字**（不是原名）：最常见的改法是「在『客厅主机』上再修两个字」
    setDraft(label)
    setEditing(true)
  }
  const commit = () => {
    // 归一化（trim / 截断 / 空等于恢复原名）全在 store 里，这里不重复一份判据
    devicesStore.rename(device.hostKey, draft)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="device device--editing">
        <input
          className="device__input"
          value={draft}
          autoFocus
          maxLength={MAX_DEVICE_NAME_LEN}
          placeholder={device.name}
          aria-label="给这台电脑起的名字"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // 手机软键盘的回车＝保存；Esc 只有带键盘的浏览器给得到
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
        <div className="device__actions">
          <button type="button" className="btn btn--small" onClick={commit}>
            保存
          </button>
          <button type="button" className="btn btn--small btn--ghost" onClick={() => setEditing(false)}>
            取消
          </button>
        </div>
        <p className="login__tip">
          留空 = 用电脑自己的名字（{device.name}）。名字只存在这台手机上，电脑那边不变。
        </p>
      </div>
    )
  }

  return (
    <div className="device">
      <div className="device__info">
        <span className="device__name">{label}</span>
        {/* 改过名才显示原名：没改过时「原名」与上面那行逐字相同，只是噪音 */}
        {device.alias && <span className="device__meta">原名 {device.name}</span>}
        <span className={`device__meta${online ? ' device__meta--online' : ''}`}>
          {onlineText} · 上次连接 {formatTime(device.lastConnectedAt)}
        </span>
        <span className={`device__meta${expired ? ' device__meta--warn' : ''}`}>
          {describeDeviceGrantText(device, state)}
        </span>
      </div>
      <div className="device__actions">
        <button type="button" className="btn btn--small" disabled={busy || expired} onClick={onConnect}>
          {expired ? '需重新扫码' : '连接'}
        </button>
        <button type="button" className="btn btn--small btn--ghost" disabled={busy} onClick={startEdit}>
          改名
        </button>
        <button type="button" className="btn btn--small btn--ghost" disabled={busy} onClick={onRemove}>
          删除
        </button>
      </div>
    </div>
  )
}

/** 凭证一行文案（过期时明确说「需重新扫码」，与错误文案同一口径）。 */
function describeDeviceGrantText(device: PairedDevice, state: 'valid' | 'expired' | 'unknown'): string {
  if (state === 'expired') return '授权凭证已过期，需重新扫码'
  if (device.expiresAt == null) return '授权凭证有效期未知（连上后自动补全）'
  // 与电脑端同一份剩余期文案实现，避免「还剩 3 天」与「2.9 天」打架
  return `授权凭证 ${describeGrantRemaining({ expiresAt: device.expiresAt })}`
}

/** 供外部（测试）复用：判断一条设备记录的凭证是否还能直接连。 */
export function canDirectConnect(device: PairedDevice, now: number = Date.now()): boolean {
  if (device.expiresAt == null) return true
  return checkGrant(
    { token: device.grant, issuedAt: device.issuedAt ?? 0, expiresAt: device.expiresAt },
    now,
  ) === null
}
