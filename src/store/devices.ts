/**
 * 已配对电脑设备记录（M2 用 localStorage；M3 迁 Rust —— 手机端是 PWA，继续用 localStorage）。
 *
 * M6 起记录里存的是**授权凭证**（`grant`，电脑端签发、30 天滑动续期、最长 90 天），
 * 而不是二维码里那张**一次性票据**。旧记录（`{id, token}`）会在读取时自动迁移：
 * `id → hostKey`、`token → grant` —— 用户不需要重新扫码。
 *
 * 字段命名与共享包对齐（`hostKey` = 电脑设备 key，房间号由它派生），
 * 免得「手机端叫 id、电脑端叫 deviceKey」这种只会在真机上暴露的错位。
 */
import { describeGrantRemaining, isGrantExpired, roomFor } from 'virlen-remote'
import { Store } from '../lib/store'

export interface PairedDevice {
  /** 电脑设备 key（房间号由 `roomFor(hostKey)` 派生）。 */
  hostKey: string
  name: string
  /** 授权凭证（电脑端是真源，这里是副本）。 */
  grant: string
  /** 凭证首次签发 / 当前到期（`undefined` = 旧记录未记录，连上后由电脑端补全）。 */
  issuedAt?: number
  expiresAt?: number
  lastConnectedAt: number
  /** 信令基址（有则走 RTC 真链路；无则同源 Broadcast 联调）。 */
  signalUrl?: string
  /** 信令房间号（缺省由 `hostKey` 派生；旧记录里带着它）。 */
  room?: string
}

const STORAGE_KEY = 'virlen.mobile.devices'

/** 把任意来源的记录归一化（含 M6 之前的旧字段名）。 */
function normalize(raw: unknown): PairedDevice | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown> & { id?: unknown; token?: unknown }
  const hostKey =
    typeof v.hostKey === 'string' && v.hostKey ? v.hostKey : typeof v.id === 'string' && v.id ? v.id : null
  const grant =
    typeof v.grant === 'string' && v.grant ? v.grant : typeof v.token === 'string' && v.token ? v.token : null
  if (!hostKey || !grant) return null
  const device: PairedDevice = {
    hostKey,
    name: typeof v.name === 'string' && v.name ? v.name : hostKey,
    grant,
    lastConnectedAt: typeof v.lastConnectedAt === 'number' ? v.lastConnectedAt : 0,
  }
  if (typeof v.issuedAt === 'number') device.issuedAt = v.issuedAt
  if (typeof v.expiresAt === 'number') device.expiresAt = v.expiresAt
  if (typeof v.signalUrl === 'string' && v.signalUrl) device.signalUrl = v.signalUrl
  if (typeof v.room === 'string' && v.room) device.room = v.room
  return device
}

function read(): PairedDevice[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalize).filter((d): d is PairedDevice => d !== null)
  } catch {
    return []
  }
}

function write(list: PairedDevice[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

class DevicesStore extends Store<PairedDevice[]> {
  constructor() {
    super(read())
  }

  /** 新增或覆盖一台电脑（`hostKey` 为唯一键）。 */
  upsert(device: PairedDevice): void {
    const list = [device, ...this.getSnapshot().filter((d) => d.hostKey !== device.hostKey)]
    write(list)
    this.setState(list)
  }

  /**
   * 局部更新（连接成功后刷新凭证 / 到期时间 / 上次连接时刻）。
   * 不改变原有顺序（列表按最新配对在前，由 `upsert` 维持）。
   */
  patch(hostKey: string, patch: Partial<PairedDevice>): void {
    let changed = false
    const list = this.getSnapshot().map((d) => {
      if (d.hostKey !== hostKey) return d
      changed = true
      return { ...d, ...patch }
    })
    if (!changed) return
    write(list)
    this.setState(list)
  }

  remove(hostKey: string): void {
    const list = this.getSnapshot().filter((d) => d.hostKey !== hostKey)
    write(list)
    this.setState(list)
  }

  find(hostKey: string): PairedDevice | null {
    return this.getSnapshot().find((d) => d.hostKey === hostKey) ?? null
  }
}

/** 凭证状态（登录页据此显示「剩余 X 天」或「已过期，需重新扫码」）。 */
export type GrantState = 'valid' | 'expired' | 'unknown'

export function grantStateOf(device: PairedDevice, now: number = Date.now()): GrantState {
  if (device.expiresAt == null) return 'unknown'
  return isGrantExpired({ token: device.grant, issuedAt: device.issuedAt ?? 0, expiresAt: device.expiresAt }, now)
    ? 'expired'
    : 'valid'
}

/** 一行文案（登录页直接显示；两端同一套口径来自共享包）。 */
export function describeDeviceGrant(device: PairedDevice, now: number = Date.now()): string {
  if (device.expiresAt == null) return '凭证有效期未知（旧版配对，连上后自动补全）'
  const state = grantStateOf(device, now)
  if (state === 'expired') return '授权凭证已过期，需重新扫码'
  return `授权凭证 ${describeGrantRemaining({ expiresAt: device.expiresAt }, now)}`
}

/** 房间号（旧记录显式带着 `room` 时优先用它，保证与旧实现逐字一致）。 */
export function roomOfDevice(device: PairedDevice): string {
  return device.room ?? roomFor(device.hostKey)
}

export const devicesStore = new DevicesStore()
