/**
 * 手机设备身份（M6，见 docs/phone-control-bridge.md §30.1）。
 *
 * 「不会重复、重新获取还是同一个」在这里实现：**首次生成随机 key → 落 localStorage → 只读复用**。
 *
 * ⚠️ 与电脑端的差别（如实说明）：
 * - 电脑端写 Rust 的 `<data_dir>/phone-identity.json`（不受浏览器存储清理影响）；
 * - 手机端是 PWA，只能写 `localStorage`。用户「清除站点数据 / 换浏览器 / 无痕模式」会换 key
 *   —— 那等同于换了一台手机，电脑端列表里会多出一台新设备（旧记录需手动移除）。
 *   这是**浏览器能给出的上限**，不是实现偷懒；真正的硬件指纹在 PWA 上不可得（且不稳定）。
 */
import { newDeviceKey } from 'virlen-remote'

export interface MobileIdentity {
  /** 手机设备 key（`mk-…`）。 */
  deviceKey: string
  /** 显示名（电脑端「已绑定手机」列表里显示它）。 */
  name: string
  createdAt: number
  /**
   * 手机**型号**（如 `Pixel 7` / `SM-S918B` / `iPhone`）。
   *
   * 2026-10 加：以前报给电脑的是「Android 手机 · 1a2b」这种**平台名**，用户在那台电脑的
   * 「已绑定手机」列表里分不清到底是哪支手机（两台安卓手机长得一模一样）。
   * 机型来源：`navigator.userAgentData.getHighEntropyValues(['model'])`（Chrome/Android，
   * 拿得到真机型）→ UA 解析兜底；两者都拿不到就不写这个字段（于是名取平台名，与旧行为一致）。
   */
  model?: string
  /**
   * `name` 是否仍由本程序自动生成（= 允许后续用机型覆盖它）。
   *
   * 缺省视为 `true`：这个字段存在之前，名字**只可能**是自动生成的（那时没有改名入口）——
   * 所以老记录应该被升级到机型名，而不是继续显示「Android 手机」。
   * 将来若加「给本机改名」，改完写 `false`，升级逻辑就不会再把用户的名字冲掉。
   */
  autoName?: boolean
}

const STORAGE_KEY = 'virlen.mobile.identity'

/** 从 UA 猜一个人能看懂的名字；猜不出就是「手机」。 */
export function deviceLabelFromUa(ua: string): string {
  if (/iPad/i.test(ua)) return 'iPad'
  if (/iPhone|iPod/i.test(ua)) return 'iPhone'
  if (/Android/i.test(ua)) return 'Android 手机'
  return '手机'
}

/**
 * 从 UA 里取机型（取不到返回 `null` —— **不猜**）。
 *
 * 三个坑（都是真机上会碰到的）：
 * 1. Chrome 110+ 的「缩减 UA」把 Android 机型抹成 `K`（WebView 是 `wv`）—— 那等于没有机型；
 * 2. 老 UA 的机型段里可能塞的是区域（`zh-cn`）或 `U`（语言标记）—— 那也不是机型；
 * 3. 机型后面常常跟 `Build/xxx`，要去掉（用户不认识内部版本号）。
 *
 * 所以做法是：把 `Android <ver>;` 之后的**所有段**都拿来当候选，逐个排除非机型 → 取第一个像机型的。
 * iOS 的 UA **从不含机型**（只有 `iPhone`），那边只能退到平台名。
 */
export function deviceModelFromUa(ua: string): string | null {
  const segment = /Android\s+[\d.]+;([^)]*)\)/.exec(ua)?.[1]
  const candidates = (segment ?? '')
    .split(';')
    .map((part) => part.trim().replace(/\s+Build\/.*$/, '').trim())
  const model = candidates.find(
    (part) =>
      part !== '' &&
      part !== 'K' &&
      part !== 'wv' &&
      part !== 'U' &&
      // 区域（`zh-cn` / `en`）不是机型
      !/^[a-z]{2}(-[A-Za-z]{2})?$/.test(part),
  )
  if (model) return model
  if (/iPhone|iPod/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  return null
}

/**
 * 设备显示名：`机型 · key 尾号`。
 *
 * 尾号不是装饰：同一个用户的第二台手机会在同列表里出现，只写机型时两条记录逐字相同，
 * 用户只能靠试。机型拿不到时退回平台名（与加机型字段之前的行为一致）。
 */
export function deviceNameFor(deviceKey: string, model: string | null, ua?: string): string {
  const label = model ?? deviceLabelFromUa(ua ?? globalThis.navigator?.userAgent ?? '')
  return `${label} · ${deviceKey.slice(-4)}`
}

/** 当前环境的默认设备名（带 key 尾号，便于同一用户的第二台手机区分）。 */
export function defaultDeviceName(deviceKey: string, ua?: string): string {
  return deviceNameFor(deviceKey, null, ua)
}

/** Chrome 的 UA-CH（只有 Chromium 系有；拿不到 high-entropy 时退 UA 解析）。 */
interface UaDataLike {
  getHighEntropyValues?(hints: string[]): Promise<{ model?: string }>
}

/**
 * 探测本机机型（**异步**：Chromium 的高熵值返回 Promise）。
 *
 * 为什么要高熵值：缩减 UA 之后，UA 字符串在任何现代安卓浏览器上都读不到机型（只有 `K`），
 * 而 `model` 高熵提示能给出真机型。它需要**安全上下文**（https / localhost），拿不到就
 * 静默退回 UA 解析 —— 探测失败不该影响任何功能。
 */
export async function detectDeviceModel(
  ua: string = globalThis.navigator?.userAgent ?? '',
): Promise<string | null> {
  try {
    const uaData = (globalThis.navigator as (Navigator & { userAgentData?: UaDataLike }) | undefined)
      ?.userAgentData
    const hints = await uaData?.getHighEntropyValues?.(['model'])
    const model = hints?.model?.trim()
    if (model) return model
  } catch {
    /* 非安全上下文 / 隐私预算用尽 → 退 UA */
  }
  return deviceModelFromUa(ua)
}

function readRaw(storage: Storage | undefined): string | null {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

function writeRaw(storage: Storage | undefined, value: string): void {
  try {
    storage?.setItem(STORAGE_KEY, value)
  } catch {
    /* 隐私模式 / 配额满：本次会话内仍用内存里的那份 */
  }
}

/** 解析已存的身份（坏数据返回 `null`，由调用方重新生成）。 */
export function parseMobileIdentity(raw: string | null | undefined): MobileIdentity | null {
  if (!raw) return null
  try {
    const obj = JSON.parse(raw) as Partial<MobileIdentity>
    if (typeof obj.deviceKey === 'string' && obj.deviceKey.trim()) {
      const deviceKey = obj.deviceKey.trim()
      const model = typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : undefined
      return {
        deviceKey,
        // 有存下来的名字就尊重它（`refreshMobileIdentity` 只在 `autoName` 时才改），
        // 否则按机型 / UA 现算一个
        name:
          typeof obj.name === 'string' && obj.name.trim()
            ? obj.name.trim()
            : deviceNameFor(deviceKey, model ?? null),
        createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
        ...(model ? { model } : {}),
        autoName: obj.autoName !== false,
      }
    }
  } catch {
    /* 坏数据 */
  }
  return null
}

/** 读取（必要时生成并持久化）手机身份。 */
export function loadMobileIdentity(
  storage: Storage | undefined = globalThis.localStorage,
  now: number = Date.now(),
): MobileIdentity {
  const existing = parseMobileIdentity(readRaw(storage))
  if (existing) return existing
  const deviceKey = newDeviceKey('mobile')
  const identity: MobileIdentity = {
    deviceKey,
    name: defaultDeviceName(deviceKey),
    createdAt: now,
    autoName: true,
  }
  writeRaw(storage, JSON.stringify(identity))
  return identity
}

let cached: MobileIdentity | null = null

/**
 * 进程内单例（懒加载）。
 *
 * 为什么需要缓存：`loadMobileIdentity()` 会在 `localStorage` 不可写时每次返回**不同的** key，
 * 而身份必须在一个会话里保持一致（hello 带的 key 与设备记录里存的必须同一个）。
 */
export function mobileIdentity(): MobileIdentity {
  if (!cached) cached = loadMobileIdentity()
  return cached
}

/**
 * 启动时探测一次机型，必要时把「报给电脑的名字」换成机型（`Pixel 7 · 1a2b`）。
 *
 * 只在 `autoName` 时才改写：名字是用户在电脑端能看到的东西，未经允许把它改掉比不改更糟
 * （用户若自己改过名，记录里 `autoName` 就是 `false`）。
 * 机型探测失败（非安全上下文 / 老浏览器）时什么都不做。
 *
 * 写回存储：下次启动直接用，不再重复探测。失败不抛出（探测失败不该影响任何功能）。
 */
export async function refreshMobileIdentity(): Promise<MobileIdentity> {
  const identity = mobileIdentity()
  const model = await detectDeviceModel()
  if (!model || model === identity.model) return identity
  if (identity.autoName === false) return identity
  const next: MobileIdentity = { ...identity, model, name: deviceNameFor(identity.deviceKey, model) }
  cached = next
  writeRaw(globalThis.localStorage, JSON.stringify(next))
  return next
}

/** 测试用：清掉缓存（生产不调用）。 */
export function resetMobileIdentityCache(): void {
  cached = null
}
