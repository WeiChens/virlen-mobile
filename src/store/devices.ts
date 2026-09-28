/**
 * 已配对电脑设备记录（M2 用 localStorage；M3 迁 Rust —— 手机端是 PWA，继续用 localStorage）。
 *
 * M6 起记录里存的是**授权凭证**（`grant`，电脑端签发、30 天滑动续期、最长 90 天），
 * 而不是二维码里那张**一次性票据**。旧记录（`{id, token}`）会在读取时自动迁移：
 * `id → hostKey`、`token → grant` —— 用户不需要重新扫码。
 *
 * 字段命名与共享包对齐（`hostKey` = 电脑设备 key，房间号由它派生），
 * 免得「手机端叫 id、电脑端叫 deviceKey」这种只会在真机上暴露的错位。
 *
 * ## 两个名字（`name` 与 `alias`）
 *
 * `name` 是**电脑端的事实**：每次 `host.hello` 都重报一遍，据此刷新；
 * `alias` 是**用户在这台手机上起的称呼**，只存在本机，电脑那边不知道。
 * 两者并存不合并：改名若直接写 `name`，下一次连接就会被电脑自报的名字冲掉，
 * 而且症状只在「连上之后」才看得见 —— 是最难复现的那类回归。
 */
import { describeGrantRemaining, isGrantExpired, roomFor } from 'virlen-remote'
import { Store } from '../lib/store'

export interface PairedDevice {
  /** 电脑设备 key（房间号由 `roomFor(hostKey)` 派生）。 */
  hostKey: string
  /** 电脑自报的名字（`host.hello` 的 `deviceName`）—— **每次连接成功都会刷新**。 */
  name: string
  /**
   * 用户在本机给这台电脑起的名字（可选）。显示时优先于 `name`，见 `deviceLabel()`。
   *
   * 为什么不让电脑端也知道：这是「我怎么叫它」，不是「它叫什么」；
   * 同步过去就要处理冲突与覆盖，而收益只是换一台手机看时名字一样 —— 不值。
   */
  alias?: string
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

/**
 * 自定义名字的长度上限（超出截断，不报错）。
 *
 * 有上限的原因不是存储，而是**版式**：设备行是一行省略号布局，几百字的「名字」
 * 会把「电脑在线 · 上次连接 …」这一行彻底挤没，用户还找不到地方改回来。
 */
export const MAX_DEVICE_NAME_LEN = 24

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
  // 空白的自定义名等于没改（否则列表上会出现一个「看起来没名字」的名字）
  if (typeof v.alias === 'string' && v.alias.trim()) {
    device.alias = v.alias.trim().slice(0, MAX_DEVICE_NAME_LEN)
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

  /**
   * 新增或覆盖一台电脑（`hostKey` 为唯一键）。
   *
   * ⚠️ **用户起的名字必须被保住**：本方法在**每次连接成功**时都会被调用
   * （`connection.ts` 拿 `host.hello` 的结果回来刷新凭证 / 到期时间），而它构造的是
   * 一个全新的对象。少了下面这步合并，改名就会「连一次就没了」。
   */
  upsert(device: PairedDevice): void {
    const prev = this.find(device.hostKey)
    // 调用方显式带了 alias 就听它的；没带则沿用旧记录的（用户的名字不是连接结果的一部分）
    const kept: PairedDevice =
      device.alias == null && prev?.alias != null ? { ...device, alias: prev.alias } : device
    const list = [kept, ...this.getSnapshot().filter((d) => d.hostKey !== device.hostKey)]
    write(list)
    this.setState(list)
  }

  /**
   * 改名（**只在本机生效**）。
   *
   * 传空 / 全空白 = 恢复电脑自报的名字。此时删掉 `alias` 而不是存空串：
   * 「有没有改过名」要是个能回答的问题（列表上要显示「原名 xxx」）。
   * 与原名完全相同的别名同样按「没改」处理，免得每台都挂着一条冗余字段。
   */
  rename(hostKey: string, name: string): void {
    const target = this.find(hostKey)
    if (!target) return
    const next = name.trim().slice(0, MAX_DEVICE_NAME_LEN)
    this.patch(hostKey, { alias: next && next !== target.name ? next : undefined })
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

/**
 * 界面上该显示的名字：**用户起的名字优先**。
 *
 * 登录页列表、连接中的提示、chat 顶栏都走这里。单点收口是必要的 ——
 * 各写一次 `alias ?? name`，迟早有一处漏掉，表现就是「列表里是『客厅主机』，
 * 进了 chat 顶栏又变回『DESKTOP-ARV3R1J』」。
 */
export function deviceLabel(device: PairedDevice): string {
  return device.alias?.trim() || device.name
}

/** 房间号（旧记录显式带着 `room` 时优先用它，保证与旧实现逐字一致）。 */
export function roomOfDevice(device: PairedDevice): string {
  return device.room ?? roomFor(device.hostKey)
}

export const devicesStore = new DevicesStore()
