/**
 * 摄像头调优单测（`lib/camera.ts`）。
 *
 * 重点覆盖**降级路径** —— 真实设备的差异极大（iOS 全不支持、Android 部分支持、
 * 有些设备声称支持变焦但 `min === max`），这些分支在真机上很难逐个复现，
 * 但一旦写错的表现是「按钮点了没反应」或「弹错误」，必须靠单测锁住。
 */
import { describe, expect, it } from 'vitest'
import {
  clampZoom,
  enableBestFocus,
  getZoom,
  probeCameraSupport,
  setTorch,
  setZoom,
  triggerFocusOnce,
} from '../lib/camera'

interface FakeTrackResult {
  track: MediaStreamTrack
  /** 实际下发给 `applyConstraints` 的参数。 */
  applied: unknown[]
}

function fakeTrack(
  caps: unknown,
  opts: { settings?: unknown; applyThrows?: boolean; noGetCapabilities?: boolean } = {},
): FakeTrackResult {
  const applied: unknown[] = []
  const track: Record<string, unknown> = {
    getSettings: () => opts.settings ?? {},
    applyConstraints: async (c: unknown) => {
      if (opts.applyThrows) throw new DOMException('nope', 'OverconstrainedError')
      applied.push(c)
    },
  }
  if (!opts.noGetCapabilities) track.getCapabilities = () => caps
  return { track: track as unknown as MediaStreamTrack, applied }
}

describe('probeCameraSupport —— 能力探测与降级', () => {
  it('iOS 典型：无 getCapabilities → 全不支持（不得抛错）', () => {
    const { track } = fakeTrack({}, { noGetCapabilities: true })
    expect(probeCameraSupport(track)).toEqual({
      focusModes: [],
      continuous: false,
      singleShot: false,
      torch: false,
      zoom: null,
    })
  })

  it('getCapabilities 返回空对象（部分 Safari）→ 全不支持', () => {
    const { track } = fakeTrack({})
    expect(probeCameraSupport(track).continuous).toBe(false)
    expect(probeCameraSupport(track).zoom).toBeNull()
  })

  it('getCapabilities 抛错 → 全不支持，不向上冒泡', () => {
    const track = {
      getCapabilities: () => {
        throw new Error('boom')
      },
    } as unknown as MediaStreamTrack
    expect(probeCameraSupport(track).focusModes).toEqual([])
  })

  it('Android 典型：continuous + single-shot + torch + zoom → 全部识别', () => {
    const { track } = fakeTrack({
      focusMode: ['continuous', 'single-shot'],
      torch: true,
      zoom: { min: 1, max: 4, step: 0.5 },
    })
    const s = probeCameraSupport(track)
    expect(s.continuous).toBe(true)
    expect(s.singleShot).toBe(true)
    expect(s.torch).toBe(true)
    expect(s.zoom).toEqual({ min: 1, max: 4, step: 0.5 })
  })

  it('只声明 continuous（无 single-shot）也能识别', () => {
    const { track } = fakeTrack({ focusMode: ['continuous'] })
    const s = probeCameraSupport(track)
    expect(s.continuous).toBe(true)
    expect(s.singleShot).toBe(false)
  })

  it('变焦 min === max（声称支持但无跨度）→ 视为不支持', () => {
    const { track } = fakeTrack({ zoom: { min: 1, max: 1, step: 0.1 } })
    expect(probeCameraSupport(track).zoom).toBeNull()
  })

  it('变焦缺 step → 按范围的 1/10 兜底', () => {
    const { track } = fakeTrack({ zoom: { min: 1, max: 5 } })
    expect(probeCameraSupport(track).zoom).toEqual({ min: 1, max: 5, step: 0.4 })
  })

  it('null / undefined track → 全不支持', () => {
    expect(probeCameraSupport(null).torch).toBe(false)
    expect(probeCameraSupport(undefined).zoom).toBeNull()
  })
})

describe('enableBestFocus —— 连续优先，退化到单次', () => {
  it('continuous 可用 → 采用 continuous', async () => {
    const { track, applied } = fakeTrack({ focusMode: ['continuous', 'single-shot'] })
    const mode = await enableBestFocus(track, probeCameraSupport(track))
    expect(mode).toBe('continuous')
    expect(applied).toEqual([{ advanced: [{ focusMode: 'continuous' }] }])
  })

  it('只有 single-shot → 采用 single-shot（由调用方周期重触发）', async () => {
    const { track, applied } = fakeTrack({ focusMode: ['single-shot'] })
    const mode = await enableBestFocus(track, probeCameraSupport(track))
    expect(mode).toBe('single-shot')
    expect(applied).toEqual([{ advanced: [{ focusMode: 'single-shot' }] }])
  })

  it('无对焦能力 → none，且**不下发**任何约束', async () => {
    const { track, applied } = fakeTrack({})
    const mode = await enableBestFocus(track, probeCameraSupport(track))
    expect(mode).toBe('none')
    expect(applied).toEqual([])
  })

  it('applyConstraints 抛错（设备声称支持却拒绝）→ 降级为 none，不冒泡', async () => {
    const { track } = fakeTrack({ focusMode: ['continuous'] }, { applyThrows: true })
    const mode = await enableBestFocus(track, probeCameraSupport(track))
    expect(mode).toBe('none')
  })
})

describe('triggerFocusOnce / setTorch / setZoom', () => {
  it('triggerFocusOnce：continuous 设备重设 continuous', async () => {
    const { track, applied } = fakeTrack({ focusMode: ['continuous'] })
    await expect(triggerFocusOnce(track, probeCameraSupport(track))).resolves.toBe(true)
    expect(applied).toEqual([{ advanced: [{ focusMode: 'continuous' }] }])
  })

  it('triggerFocusOnce：单次对焦设备触发 single-shot', async () => {
    const { track, applied } = fakeTrack({ focusMode: ['single-shot'] })
    await triggerFocusOnce(track, probeCameraSupport(track))
    expect(applied).toEqual([{ advanced: [{ focusMode: 'single-shot' }] }])
  })

  it('triggerFocusOnce：不支持时返回 false（UI 据此隐藏入口）', async () => {
    const { track } = fakeTrack({})
    await expect(triggerFocusOnce(track, probeCameraSupport(track))).resolves.toBe(false)
  })

  it('setTorch：支持时下发 torch，失败返回 false', async () => {
    const ok = fakeTrack({ torch: true })
    await expect(setTorch(ok.track, true)).resolves.toBe(true)
    expect(ok.applied).toEqual([{ advanced: [{ torch: true }] }])

    const bad = fakeTrack({}, { applyThrows: true })
    await expect(setTorch(bad.track, true)).resolves.toBe(false)
  })

  it('setZoom / getZoom：读回当前倍率，null 安全', async () => {
    const { track } = fakeTrack({}, { settings: { zoom: 2 } })
    expect(getZoom(track)).toBe(2)
    expect(getZoom(null)).toBeNull()

    const { track: t2, applied } = fakeTrack({})
    await setZoom(t2, 3)
    expect(applied).toEqual([{ advanced: [{ zoom: 3 }] }])
  })
})

describe('clampZoom —— 夹取 + 步进对齐', () => {
  const range = { min: 1, max: 4, step: 0.5 }

  it('夹到范围内', () => {
    expect(clampZoom(0.2, range)).toBe(1)
    expect(clampZoom(9, range)).toBe(4)
  })

  it('按步进对齐（含步进为 0.3 这类不整除值）', () => {
    expect(clampZoom(2.2, range)).toBe(2)
    expect(clampZoom(2.3, range)).toBe(2.5)
    expect(clampZoom(1.97, { min: 1, max: 3, step: 0.3 })).toBe(1.9)
  })

  it('步进无限小/范围退化也不会越界或产生 NaN', () => {
    const tiny = { min: 1, max: 1.0001, step: 0.00001 }
    const v = clampZoom(1.00005, tiny)
    expect(Number.isNaN(v)).toBe(false)
    expect(v).toBeGreaterThanOrEqual(tiny.min)
    expect(v).toBeLessThanOrEqual(tiny.max)
  })
})
