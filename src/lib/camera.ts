/**
 * 摄像头调优（对焦 / 变焦 / 补光）—— **Web 平台的能力边界在本文件收口**。
 *
 * ⚠️ **改代码前先读这段**：网页对摄像头的控制力远弱于原生相机 App，边界如下：
 *
 * | 能力 | Web 可用性 |
 * |---|---|
 * | 连续自动对焦 `focusMode: 'continuous'` | 仅部分 Android Chrome（取决于 `getCapabilities()`） |
 * | 单次对焦 `'single-shot'` | 同上；可作「点一下重新对焦」的近似 |
 * | **点按对焦到指定坐标**（`pointsOfInterest`） | ❌ **浏览器不暴露**，Web 上**无法实现** |
 * | 手动对焦距离 `focusDistance` | ❌ 基本不可用 |
 * | 补光 `torch` | 部分 Android Chrome |
 * | 变焦 `zoom` | 部分设备（数码/光学） |
 * | **iOS Safari** | ❌ **以上全部不可用**：对焦完全由系统接管，`applyConstraints` 的不支持项被**静默忽略** |
 *
 * 所以本模块一律「**先探测、再应用、失败不抛错**」：全部返回布尔/降级值，
 * 由 UI 决定是显示按钮还是显示「本设备不支持」的说明 ——
 * **绝不假定支持**（否则 iOS 上会出现点了没反应的按钮，比没有更糟）。
 */

/** `focusMode` / `torch` / `zoom` 属 Image Capture 扩展，TS 的 `MediaTrackCapabilities` 未覆盖，故显式声明。 */
interface ExtendedCapabilities {
  focusMode?: string[]
  torch?: boolean
  zoom?: { min?: number; max?: number; step?: number }
}

/** 探测到的可调优能力。 */
export interface CameraSupport {
  /** 设备声明的对焦模式。**空数组 = 无法在网页内控制对焦**（典型：iOS Safari）。 */
  focusModes: string[]
  /** 支持连续自动对焦。 */
  continuous: boolean
  /** 支持单次对焦（可用来「重新对焦」）。 */
  singleShot: boolean
  /** 支持补光。 */
  torch: boolean
  /** 变焦范围；`null` = 不支持。 */
  zoom: { min: number; max: number; step: number } | null
}

const NO_SUPPORT: CameraSupport = {
  focusModes: [],
  continuous: false,
  singleShot: false,
  torch: false,
  zoom: null,
}

/**
 * 探测摄像头能力。
 *
 * `getCapabilities()` 在部分浏览器（尤其 iOS Safari）**不存在或返回空对象**，
 * 此时按「全不支持」处理 —— 让 UI 走说明文案而不是无效按钮。
 */
export function probeCameraSupport(track: MediaStreamTrack | null | undefined): CameraSupport {
  if (!track || typeof track.getCapabilities !== 'function') return NO_SUPPORT

  let caps: ExtendedCapabilities
  try {
    caps = track.getCapabilities() as unknown as ExtendedCapabilities
  } catch {
    return NO_SUPPORT
  }

  const focusModes = Array.isArray(caps.focusMode) ? caps.focusMode : []
  const z = caps.zoom
  // 变焦范围必须有实际跨度才可用（有些设备返回 min===max，属"声称支持但无效果"）
  const zoom =
    z && typeof z.min === 'number' && typeof z.max === 'number' && z.max > z.min
      ? {
          min: z.min,
          max: z.max,
          step: typeof z.step === 'number' && z.step > 0 ? z.step : (z.max - z.min) / 10,
        }
      : null

  return {
    focusModes,
    continuous: focusModes.includes('continuous'),
    singleShot: focusModes.includes('single-shot'),
    torch: caps.torch === true,
    zoom,
  }
}

/**
 * 应用一条高级约束。
 *
 * 用 `advanced` 而非 `exact`：**不支持的项会被浏览器忽略**，而不会让整条约束失败 ——
 * 同一份代码要同时跑在「支持」与「不支持」两类设备上，这是唯一稳妥的写法。
 */
export async function applyCameraConstraint(
  track: MediaStreamTrack | null | undefined,
  constraint: Record<string, unknown>,
): Promise<boolean> {
  if (!track || typeof track.applyConstraints !== 'function') return false
  try {
    await track.applyConstraints({ advanced: [constraint as unknown as MediaTrackConstraintSet] })
    return true
  } catch {
    return false
  }
}

/** 实际采用的对焦方式。 */
export type AppliedFocusMode = 'continuous' | 'single-shot' | 'none'

/**
 * 打开流后尽力启用自动对焦：连续优先，退化到单次。
 *
 * 返回 `'single-shot'` 时调用方应**周期性再触发一次**（见 `triggerFocusOnce`）——
 * 单次对焦只在对焦那一刻生效，不重触发就会一直停在失焦状态。
 */
export async function enableBestFocus(
  track: MediaStreamTrack | null | undefined,
  support: CameraSupport,
): Promise<AppliedFocusMode> {
  if (support.continuous && (await applyCameraConstraint(track, { focusMode: 'continuous' }))) {
    return 'continuous'
  }
  if (support.singleShot && (await applyCameraConstraint(track, { focusMode: 'single-shot' }))) {
    return 'single-shot'
  }
  return 'none'
}

/**
 * 「重新对焦」—— Web 上对点按对焦的**近似**：促使设备重新评估场景，但**无法指定对焦点**。
 *
 * 不支持时返回 `false`，UI 据此隐藏入口（而不是给一个点了没反应的按钮）。
 */
export async function triggerFocusOnce(
  track: MediaStreamTrack | null | undefined,
  support: CameraSupport,
): Promise<boolean> {
  if (support.continuous) {
    // continuous 下设备本就在持续对焦；重设一次可促使它重新评估（部分机型上确实有效）
    return applyCameraConstraint(track, { focusMode: 'continuous' })
  }
  if (support.singleShot) {
    return applyCameraConstraint(track, { focusMode: 'single-shot' })
  }
  return false
}

/** 开关补光（暗光下扫码失败常被误当成「对不上焦」）。 */
export async function setTorch(
  track: MediaStreamTrack | null | undefined,
  on: boolean,
): Promise<boolean> {
  return applyCameraConstraint(track, { torch: on })
}

/** 读取当前变焦倍率；不支持时返回 `null`。 */
export function getZoom(track: MediaStreamTrack | null | undefined): number | null {
  if (!track || typeof track.getSettings !== 'function') return null
  try {
    const s = track.getSettings() as unknown as { zoom?: number }
    return typeof s.zoom === 'number' ? s.zoom : null
  } catch {
    return null
  }
}

/** 设置变焦倍率（超出设备范围会被忽略，返回 `false`）。 */
export async function setZoom(
  track: MediaStreamTrack | null | undefined,
  value: number,
): Promise<boolean> {
  return applyCameraConstraint(track, { zoom: value })
}

/**
 * 把倍率夹到设备范围并按步进对齐 —— 纯函数，便于单测。
 * `step` 为 0/缺失时按范围的 1/10 处理（与 `probeCameraSupport` 一致）。
 */
export function clampZoom(value: number, range: { min: number; max: number; step: number }): number {
  const clamped = Math.min(range.max, Math.max(range.min, value))
  const steps = Math.round((clamped - range.min) / range.step)
  const snapped = range.min + steps * range.step
  // 对齐后可能越过边界（浮点误差），再夹一次
  return Math.min(range.max, Math.max(range.min, Number(snapped.toFixed(2))))
}
