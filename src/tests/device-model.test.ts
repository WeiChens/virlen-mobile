/**
 * 手机机型探测单测（报给电脑的「本机名称」用的就是它）。
 *
 * 为什么要单独钉住：这个名字是**用户在电脑端唯一能看到手机的地方**（「已绑定手机」列表 /
 * 配对确认框）。它写错的后果不是报错，而是「两台手机在列表里长得一模一样」——
 * 用户只能靠试。而能从 UA 里拿到什么完全是运气（平台 / 浏览器 / 是否被缩减），
 * 所以每一类 UA 都得有用例：拿到机型的、只拿到平台的、压根不是手机的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultDeviceName,
  detectDeviceModel,
  deviceModelFromUa,
  deviceNameFor,
  loadMobileIdentity,
  mobileIdentity,
  refreshMobileIdentity,
  resetMobileIdentityCache,
} from '../lib/identity'

const ANDROID_PIXEL =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const ANDROID_SAMSUNG =
  'Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
/** Chrome 110+ 的「缩减 UA」：机型被抹成 `K` —— 这条路径下**只能**靠 UA-CH。 */
const ANDROID_REDUCED =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
/** 老 UA：机型段中间还夹着语言与区域 */
const ANDROID_OLD =
  'Mozilla/5.0 (Linux; U; Android 4.0.3; zh-cn; GT-I9300 Build/IML74K) AppleWebKit/534.30 Mobile Safari/534.30'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

/** UA-CH 的桩：`model` 有值就走它（真机型），否则视为「拿不到」。 */
function stubUaData(model: string | null): void {
  vi.stubGlobal('navigator', {
    userAgent: ANDROID_REDUCED,
    userAgentData: {
      getHighEntropyValues: () => Promise.resolve(model ? { model } : {}),
    },
  })
}

beforeEach(() => {
  localStorage.clear()
  resetMobileIdentityCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deviceModelFromUa —— 从 UA 里认出机型', () => {
  it('Android：拿得到机型就报机型（去掉 Build/ 内部版本号）', () => {
    expect(deviceModelFromUa(ANDROID_PIXEL)).toBe('Pixel 7')
    expect(deviceModelFromUa(ANDROID_SAMSUNG)).toBe('SM-S918B')
    // 机型段里夹着语言 / 区域时，跳过它们继续找
    expect(deviceModelFromUa(ANDROID_OLD)).toBe('GT-I9300')
  })

  it('缩减 UA（机型 = `K`）：没有机型可报 → null（不把 K 当机型）', () => {
    expect(deviceModelFromUa(ANDROID_REDUCED)).toBe(null)
  })

  it('iOS：UA 里只有平台名（本来就没有机型）', () => {
    expect(deviceModelFromUa(IPHONE)).toBe('iPhone')
    expect(deviceModelFromUa(IPAD)).toBe('iPad')
  })

  it('电脑浏览器：拿不到机型 → null', () => {
    expect(deviceModelFromUa(DESKTOP)).toBe(null)
  })
})

describe('deviceNameFor —— 机型 · key 尾号', () => {
  it('有型号用型号；没有就退回平台名（与加机型之前的行为一致）', () => {
    expect(deviceNameFor('mk-0123456789abcdef', 'Pixel 7')).toBe('Pixel 7 · cdef')
    expect(deviceNameFor('mk-0123456789abcdef', null, 'Mozilla/5.0 (Linux; Android 14)')).toBe(
      'Android 手机 · cdef',
    )
    expect(defaultDeviceName('mk-0123456789abcdef', 'Android')).toBe('Android 手机 · cdef')
  })
})

describe('detectDeviceModel —— 优先 UA-CH，退 UA', () => {
  it('Chromium 给了 model 就用它（缩减 UA 下唯一能拿到真机型的来源）', async () => {
    stubUaData('Pixel 7 Pro')
    expect(await detectDeviceModel()).toBe('Pixel 7 Pro')
  })

  it('没有 UA-CH / model 为空 → 退回 UA 解析', async () => {
    stubUaData(null)
    expect(await detectDeviceModel()).toBe(null)
    vi.stubGlobal('navigator', { userAgent: ANDROID_PIXEL })
    expect(await detectDeviceModel()).toBe('Pixel 7')
  })

  it('UA-CH 抛错（非安全上下文 / 隐私预算用尽）→ 静默退 UA，不抛', async () => {
    vi.stubGlobal('navigator', {
      userAgent: ANDROID_PIXEL,
      userAgentData: {
        getHighEntropyValues: () => Promise.reject(new Error('not allowed')),
      },
    })
    expect(await detectDeviceModel()).toBe('Pixel 7')
  })
})

/**
 * 老记录（没写 `autoName`）里的名字**只可能**是自动生成的（那时没有改名入口）
 * → 应该被升级成机型名，而不是继续显示「Android 手机」。
 */
describe('refreshMobileIdentity —— 只在「名字还是自动生成的」时才改', () => {
  it('自动名（旧版生成的平台名）→ 升级成机型名，并写回存储', async () => {
    const deviceKey = 'mk-0123456789abcdef'
    localStorage.setItem(
      'virlen.mobile.identity',
      JSON.stringify({ deviceKey, name: defaultDeviceName(deviceKey), createdAt: 1 }),
    )
    resetMobileIdentityCache()
    stubUaData('Pixel 7')

    const next = await refreshMobileIdentity()
    expect(next.name).toBe('Pixel 7 · cdef')
    expect(next.model).toBe('Pixel 7')
    // 写回存储：下次启动不必再探测（也不再闪一次平台名）
    expect(JSON.parse(localStorage.getItem('virlen.mobile.identity')!).name).toBe('Pixel 7 · cdef')
    expect(mobileIdentity().name).toBe('Pixel 7 · cdef')
  })

  it('名字是用户改过的（autoName=false）→ 一个字都不动', async () => {
    const deviceKey = 'mk-0123456789abcdef'
    localStorage.setItem(
      'virlen.mobile.identity',
      JSON.stringify({ deviceKey, name: '客厅那台手机', createdAt: 1, autoName: false }),
    )
    resetMobileIdentityCache()
    stubUaData('Pixel 7')

    expect((await refreshMobileIdentity()).name).toBe('客厅那台手机')
    expect(JSON.parse(localStorage.getItem('virlen.mobile.identity')!).name).toBe('客厅那台手机')
  })

  it('探测不到机型 → 什么都不做（保持旧行为）', async () => {
    const deviceKey = 'mk-0123456789abcdef'
    const original = defaultDeviceName(deviceKey)
    localStorage.setItem(
      'virlen.mobile.identity',
      JSON.stringify({ deviceKey, name: original, createdAt: 1 }),
    )
    resetMobileIdentityCache()
    vi.stubGlobal('navigator', { userAgent: DESKTOP })

    const next = await refreshMobileIdentity()
    expect(next.name).toBe(original)
    expect(next.model).toBeUndefined()
  })

  it('首次生成的身份也能被升级（老用户的第一次启动）', async () => {
    const first = loadMobileIdentity()
    expect(first.model).toBeUndefined()
    stubUaData('Pixel 7')
    expect((await refreshMobileIdentity()).model).toBe('Pixel 7')
  })
})
