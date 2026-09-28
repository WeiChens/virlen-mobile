/**
 * 扫码像素预算单测（`lib/scan-plan.ts`）。
 *
 * 重点覆盖**各种采集规格与降级路径**：真机上不同机型给的分辨率五花八门（有的只有 640×480、
 * 有的问 1080p 给 4K、有的一直是竖屏 1080×1920），而这些分支在真机上很难逐个复现，
 * 一旦算错的表现是「某台手机彻底扫不到」或「主线程卡死」——都必须靠单测锁住。
 *
 * 数值都是手算的期望值，**改动 `scan-plan.ts` 里的常量会在这里立刻暴露**（这是有意的）。
 */
import { describe, expect, it } from 'vitest'
import {
  CAPTURE_IDEAL,
  CENTER_CROP,
  MAX_CENTER_SIDE,
  MAX_FULL_SIDE,
  planScanRegions,
  type ScanRegion,
} from '../lib/scan-plan'

/** 各种机型真实会给到的帧尺寸（含竖屏、4K、低端机、退化值）。 */
const FRAME_SIZES: Array<[number, number]> = [
  [1280, 720], // 旧实现请求到的（对比基准）
  [1920, 1080], // 现在的请求值
  [1080, 1920], // 竖屏手机（多数机型上报的是传感器方向）
  [3840, 2160], // 问 1080p 给了 4K
  [640, 480], // 低端机 / 降级
  [320, 240], // 极端降级
  [100, 1000], // 长条比例（防御性：竖屏裁切异常时出现）
  [1, 1], // 退化：中心区与全帧重合
]

describe('CAPTURE_IDEAL —— 采集像素预算（决定「拉远到多远还能扫到」）', () => {
  it('不低于 1080p：这是「站远一点仍然有足够像素」的物理前提', () => {
    expect(CAPTURE_IDEAL.width * CAPTURE_IDEAL.height).toBeGreaterThanOrEqual(1920 * 1080)
    // 相对旧值 720p 的像素倍数（用户能站多远的线性倍数 ≈ 其平方根）
    expect((CAPTURE_IDEAL.width * CAPTURE_IDEAL.height) / (1280 * 720)).toBeCloseTo(2.25, 2)
  })
})

describe('planScanRegions —— 中心优先、全帧兜底', () => {
  it('1080p 横屏：中心 864²（不缩放），兜底等比缩成 1280×720', () => {
    expect(planScanRegions(1920, 1080)).toEqual([
      { sx: 528, sy: 108, sw: 864, sh: 864, dw: 864, dh: 864 },
      { sx: 0, sy: 0, sw: 1920, sh: 1080, dw: 1280, dh: 720 },
    ])
  })

  it('720p 横屏：中心 576²，兜底 1:1 不缩放（与旧实现的像素量一致，可作对照）', () => {
    expect(planScanRegions(1280, 720)).toEqual([
      { sx: 352, sy: 72, sw: 576, sh: 576, dw: 576, dh: 576 },
      { sx: 0, sy: 0, sw: 1280, sh: 720, dw: 1280, dh: 720 },
    ])
  })

  it('竖屏 1080×1920：按**短边**取中心，兜底 720×1280', () => {
    expect(planScanRegions(1080, 1920)).toEqual([
      { sx: 108, sy: 528, sw: 864, sh: 864, dw: 864, dh: 864 },
      { sx: 0, sy: 0, sw: 1080, sh: 1920, dw: 720, dh: 1280 },
    ])
  })

  it('4K：中心封顶到 MAX_CENTER_SIDE，像素预算不随采集规格爆炸', () => {
    const [center, full] = planScanRegions(3840, 2160)
    // 不封顶的话中心区是 1728² ≈ 3.0M 像素（约 4 倍预算）→ 主线程会饱和
    expect(center).toEqual({ sx: 1056, sy: 216, sw: 1728, sh: 1728, dw: 1024, dh: 1024 })
    expect(full).toEqual({ sx: 0, sy: 0, sw: 3840, sh: 2160, dw: 1280, dh: 720 })
  })

  it('低端机 640×480 / 320×240：只缩不放，兜底保持原尺寸', () => {
    expect(planScanRegions(640, 480)).toEqual([
      { sx: 128, sy: 48, sw: 384, sh: 384, dw: 384, dh: 384 },
      { sx: 0, sy: 0, sw: 640, sh: 480, dw: 640, dh: 480 },
    ])
    const [, tiny] = planScanRegions(320, 240)
    expect(tiny).toEqual({ sx: 0, sy: 0, sw: 320, sh: 240, dw: 320, dh: 240 })
  })

  it('退化帧（1×1）：中心区与全帧重合时只扫一次，不重复解同一块像素', () => {
    expect(planScanRegions(1, 1)).toHaveLength(1)
  })

  it('非法尺寸 → 空数组（调用方跳过本轮，而不是拿 NaN 去 drawImage 抛错）', () => {
    expect(planScanRegions(0, 0)).toEqual([])
    expect(planScanRegions(0, 1080)).toEqual([])
    expect(planScanRegions(1920, 0)).toEqual([])
    expect(planScanRegions(-1920, -1080)).toEqual([])
    expect(planScanRegions(Number.NaN, 1080)).toEqual([])
    expect(planScanRegions(Number.POSITIVE_INFINITY, 1080)).toEqual([])
  })
})

describe('planScanRegions —— 不变量（对任何采集规格都必须成立）', () => {
  it('区域都在帧内、尺寸为正、且**只缩不放**（放大不会多出信息，只会烧 CPU）', () => {
    for (const [w, h] of FRAME_SIZES) {
      for (const r of planScanRegions(w, h)) {
        expect(r.sx).toBeGreaterThanOrEqual(0)
        expect(r.sy).toBeGreaterThanOrEqual(0)
        expect(r.sx + r.sw).toBeLessThanOrEqual(w)
        expect(r.sy + r.sh).toBeLessThanOrEqual(h)
        expect(r.dw).toBeGreaterThan(0)
        expect(r.dh).toBeGreaterThan(0)
        expect(r.dw).toBeLessThanOrEqual(r.sw)
        expect(r.dh).toBeLessThanOrEqual(r.sh)
      }
    }
  })

  it('中心区是「居中的正方形」（与取景框对齐的前提）', () => {
    for (const [w, h] of FRAME_SIZES) {
      const center = planScanRegions(w, h)[0]
      expect(center.sw).toBe(center.sh)
      expect(center.dw).toBe(center.dh)
      // 允许 0.5px 的 round 偏差
      expect(Math.abs(center.sx + center.sw / 2 - w / 2)).toBeLessThanOrEqual(1)
      expect(Math.abs(center.sy + center.sh / 2 - h / 2)).toBeLessThanOrEqual(1)
    }
  })

  it('中心区边长 = 短边 × CENTER_CROP（封顶前）', () => {
    for (const [w, h] of FRAME_SIZES) {
      const center = planScanRegions(w, h)[0]
      const expected = Math.round(Math.min(Math.floor(w), Math.floor(h)) * CENTER_CROP)
      // 退化帧（1×1）下 round 会让 0.8 → 1，属预期
      expect(center.sw).toBe(Math.max(1, expected))
    }
  })

  it('像素预算封顶：任何规格下单个区域都不超过预算（这是主线程不饱和的保证）', () => {
    const budget = Math.max(MAX_CENTER_SIDE, MAX_FULL_SIDE)
    for (const [w, h] of FRAME_SIZES) {
      const regions: ScanRegion[] = planScanRegions(w, h)
      for (const r of regions) {
        expect(Math.max(r.dw, r.dh)).toBeLessThanOrEqual(budget)
        // 最坏区域（全帧兜底）的像素量上界 = 边长封顶的平方
        expect(r.dw * r.dh).toBeLessThanOrEqual(MAX_FULL_SIDE * MAX_FULL_SIDE)
      }
    }
  })

  it('1080p 下的最坏解码量 ≈ 旧实现 720p 的 1.33 倍（+1/3 换主路径 2.25 倍像素）', () => {
    const pixels = (regions: ScanRegion[]): number =>
      regions.reduce((sum, r) => sum + r.dw * r.dh, 0)
    const oldTotal = pixels(planScanRegions(1280, 720))
    const newTotal = pixels(planScanRegions(1920, 1080))
    expect(newTotal / oldTotal).toBeGreaterThan(1.3)
    expect(newTotal / oldTotal).toBeLessThan(1.4)
  })
})
