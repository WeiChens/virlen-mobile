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
}

const STORAGE_KEY = 'virlen.mobile.identity'

/** 从 UA 猜一个人能看懂的名字；猜不出就是「手机」。 */
export function deviceLabelFromUa(ua: string): string {
  if (/iPad/i.test(ua)) return 'iPad'
  if (/iPhone|iPod/i.test(ua)) return 'iPhone'
  if (/Android/i.test(ua)) return 'Android 手机'
  return '手机'
}

/** 当前环境的默认设备名（带 key 尾号，便于同一用户的第二台手机区分）。 */
export function defaultDeviceName(deviceKey: string, ua?: string): string {
  const label = deviceLabelFromUa(ua ?? globalThis.navigator?.userAgent ?? '')
  return `${label} · ${deviceKey.slice(-4)}`
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
      return {
        deviceKey: obj.deviceKey.trim(),
        name:
          typeof obj.name === 'string' && obj.name.trim()
            ? obj.name.trim()
            : defaultDeviceName(obj.deviceKey.trim()),
        createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
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
  const identity: MobileIdentity = { deviceKey, name: defaultDeviceName(deviceKey), createdAt: now }
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

/** 测试用：清掉缓存（生产不调用）。 */
export function resetMobileIdentityCache(): void {
  cached = null
}
