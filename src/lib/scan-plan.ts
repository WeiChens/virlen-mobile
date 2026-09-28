/**
 * 扫码的**像素预算**（采集分辨率 + 解码区域规划）—— 纯函数，便于单测。
 *
 * ## 为什么需要这个模块
 *
 * 真机反馈「对着屏幕扫不到码」。在 Web 上**对焦不可控**（见 `camera.ts` 文件头：iOS 全不支持、
 * Android 只有部分机型能设 `focusMode`），于是只剩两个可调的旋钮 —— 而它们是**互相矛盾**的：
 *
 * - **站太近** → 低于镜头的最近对焦距离（多数手机 10~20cm），画面必糊。
 *   这是**光学问题**，任何软件、任何框架都救不了（RN / 原生 App 一样糊）。
 * - **站远一点** → 对焦正常了，但同一块屏幕上的二维码在画面里变小，
 *   **码上的像素不够 jsQR 解**——看起来同样是「扫不到」，成因却完全不同。
 *
 * 本模块就是为第二条服务的两件事：
 *
 * 1. `CAPTURE_IDEAL`：采集分辨率从 **720p 提到 1080p**。同样的取景范围里，码上的像素
 *    面积变成 2.25 倍 → **「还能解出来的最远距离」被拉长**。这是「拉远」这个建议能成立的
 *    物理前提：没有这一条，让用户站远只会让码更小、更解不出来。
 * 2. `planScanRegions()`：算出每个解码区域「从哪儿剪、剪多大送进 jsQR」，
 *    把解码开销钉死在 QrScanner 的 10fps 预算内。
 *
 * ## ⚠️ 改常量前先读：像素预算怎么钉的
 *
 * jsQR 的耗时 ≈ 送进去的像素数，所以「提高采集分辨率」若不同时封顶解码尺寸，
 * 就会变成「主线程饱和 → 掉帧、发热 → 反而更扫不到」。
 *
 * | 区域 | 作用 | 送进 jsQR 的尺寸 |
 * |---|---|---|
 * | ① 中心方块（主路径，居中） | 绝大多数帧的解 | 原生像素**不缩放**，边长封顶 `MAX_CENTER_SIDE` |
 * | ② 全帧兜底 | 覆盖「码不在中心」 | **等比缩小**到 `MAX_FULL_SIDE` 以内 |
 *
 * 具体数字（1080p 采集下）：
 * - ① 中心 = 0.8 × 1080 = **864²**（未触顶）——与旧实现 720p 全帧（1280×720）的解码量同量级；
 * - ② 兜底 = 1920×1080 缩成 **1280×720** —— 与旧实现 720p 全帧**完全相同**的像素数。
 *
 * 即：**每轮最坏解码量从 1.25M 涨到 1.67M 像素（约 +1/3）**，换来主路径码上像素 ×2.25。
 * 这个取舍是有意的 —— 兜底帧里的码本来就大（否则也不该指望兜底），不值得为它多花预算；
 * 预算该花在「让用户能站远一点」上。
 */

/** 期望的采集分辨率。**只作 `ideal` 下发给 `getUserMedia`**：不支持的机型自行降级，不会失败。 */
export const CAPTURE_IDEAL = { width: 1920, height: 1080 } as const

/** 中心区送入 jsQR 的**最大边长**（像素预算上限）。4K 采集下会把 1728 封到 1024。 */
export const MAX_CENTER_SIDE = 1024

/** 全帧兜底送入 jsQR 的**最大边长**（等比缩小，只缩不放）。1080p 下 = 1280×720。 */
export const MAX_FULL_SIDE = 1280

/**
 * 优先扫描的中心区边长比例（相对视频帧的**短边**）。
 *
 * 为什么用「短边」而不是「宽高各一个比例」：取景是**全屏 + `object-fit: contain`**（完整视野，
 * 横屏流在竖屏上会上下留黑边），画面居中的那块区域最可能是用户对准的地方，取「短边」
 * 为中心区能在各种屏幕比例下都大致对齐它，而中心区面积小、二值化与定位图案扫描都快。
 *
 * ⚠️ 中心区只是**快路径**，不是「只有这里能扫」：全屏取景下解码仍覆盖**全帧**（下面的兜底），
 * 码放在屏幕任意位置都能扫到 —— 屏幕上那个取景框（reticle）仅是视觉引导。
 *
 * 面积只有全帧的 ~36%（1080p 下 864² = 0.75M 像素 vs 全帧 2.07M），二值化与定位图案扫描都快得多；
 * 全帧作兜底。
 */
export const CENTER_CROP = 0.8

/**
 * 一个解码区域：**从视频帧的哪儿剪**（`sx/sy/sw/sh`）+ **剪多大送进 jsQR**（`dw/dh`）。
 *
 * 两者分开的原因：canvas 尺寸固定为视频原始分辨率（见 QrScanner 里「避免每帧改 canvas 尺寸」），
 * 于是「裁剪」用源矩形表达、「缩放」用目标矩形表达，一次 `drawImage` 同时完成。
 */
export interface ScanRegion {
  /** 源矩形左上角 x（视频帧坐标）。 */
  sx: number
  /** 源矩形左上角 y。 */
  sy: number
  /** 源矩形宽。 */
  sw: number
  /** 源矩形高。 */
  sh: number
  /** 目标宽（= 送进 jsQR 的宽）。 */
  dw: number
  /** 目标高。 */
  dh: number
}

/**
 * 规划本轮要扫的区域：**中心优先、全帧兜底**。
 *
 * 顺序即优先级：中心区是绝大多数帧的最优路径（面积小、解码快、且落在画面中心），
 * 全帧只在中心没扫到时才跑（不这样处理会漏掉靠边的码）。
 *
 * 纯函数：`vw/vh` 是视频帧的原始尺寸，非法值（0 / 负数 / NaN）返回**空数组** ——
 * 调用方据此直接跳过本轮，而不是拿 `NaN` 去 `drawImage`（会抛错，把整棵组件树搞崩）。
 */
export function planScanRegions(vw: number, vh: number): ScanRegion[] {
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) return []

  const w = Math.floor(vw)
  const h = Math.floor(vh)
  const regions: ScanRegion[] = []

  // ① 中心方块（居中；边长按短边算）
  const side = Math.round(Math.min(w, h) * CENTER_CROP)
  if (side > 0) {
    const draw = Math.min(side, MAX_CENTER_SIDE)
    regions.push({
      sx: Math.round((w - side) / 2),
      sy: Math.round((h - side) / 2),
      sw: side,
      sh: side,
      dw: draw,
      dh: draw,
    })
  }

  // ② 全帧兜底（等比缩到预算内；**只缩不放** —— 放大不会多出信息，只会白烧 CPU）
  const scale = Math.min(1, MAX_FULL_SIDE / Math.max(w, h))
  const dw = Math.max(1, Math.round(w * scale))
  const dh = Math.max(1, Math.round(h * scale))
  const center = regions[0]
  const sameAsFullFrame =
    center !== undefined && center.sx === 0 && center.sy === 0 && center.sw === w && center.sh === h
  // 只有把 CENTER_CROP 调到 1（或帧小到退化）时二者才会重合；保留这个判断是为了
  // 「万一以后调大比例」不会对同一块像素白解一遍。
  if (!sameAsFullFrame) regions.push({ sx: 0, sy: 0, sw: w, sh: h, dw, dh })

  return regions
}
