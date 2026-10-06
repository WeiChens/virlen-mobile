/**
 * 界面偏好（主题 / 界面大小）单测：纯函数口径 + store 落到 DOM 的那一步。
 *
 * 为什么 store 也要测：「跟随系统」的整条链路（读 `matchMedia` → 解析 → 写 `<html>` 属性 →
 * 系统换了再写一次）全是**接线**，没有算法 —— 纯函数测不到，而它在真机上错了就是
 * 「手机切了深色、应用还是白的」这种说不清的现象。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_PREFS,
  SIZE_PREFS,
  isSizePref,
  isThemePref,
  parsePrefs,
  resolveTheme,
  serializePrefs,
} from '../lib/prefs'
import { prefsStore } from '../store/prefs'

const STORAGE_KEY = 'virlen.mobile.ui-prefs'

/** `matchMedia` 的桩（jsdom 没有实现它）：可读 + 可手动触发 change。 */
function stubMatchMedia(initialDark: boolean) {
  const listeners = new Set<() => void>()
  let dark = initialDark
  const mql = {
    get matches() {
      return dark
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn),
  }
  vi.stubGlobal('matchMedia', () => mql as unknown as MediaQueryList)
  return {
    /** 模拟「用户切了系统主题」。 */
    systemChange(next: boolean): void {
      dark = next
      for (const fn of [...listeners]) fn()
    },
    listenerCount: () => listeners.size,
  }
}

const root = (): HTMLElement => document.documentElement

beforeEach(() => {
  localStorage.clear()
  prefsStore.reset()
  // 上一个用例可能留下属性（jsdom 的 document 是整个文件共用的）
  delete root().dataset.theme
  delete root().dataset.size
})

afterEach(() => {
  prefsStore.reset()
  vi.unstubAllGlobals()
})

describe('偏好纯函数', () => {
  it('parsePrefs：坏数据 / 空值 → 默认（不抛错）', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('')).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('{ not json')).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('"dark"')).toEqual(DEFAULT_PREFS)
  })

  it('parsePrefs：只回退非法的那一项（另一项仍生效）', () => {
    expect(parsePrefs('{"theme":"light","size":"l"}')).toEqual({ theme: 'light', size: 'l' })
    // size 非法 → 只回退 size
    expect(parsePrefs('{"theme":"light","size":"huge"}')).toEqual({ theme: 'light', size: 'm' })
    // theme 非法 → 只回退 theme
    expect(parsePrefs('{"theme":"blue","size":"s"}')).toEqual({ theme: 'system', size: 's' })
  })

  it('序列化 → 解析：往返一致（存的就是这两个字段）', () => {
    expect(parsePrefs(serializePrefs({ theme: 'dark', size: 's' }))).toEqual({
      theme: 'dark',
      size: 's',
    })
  })

  it('类型守卫：只认固定取值（主题三档 / 界面大小五档）', () => {
    expect(['system', 'light', 'dark'].every(isThemePref)).toBe(true)
    expect(isThemePref('auto')).toBe(false)
    expect(isThemePref(undefined)).toBe(false)
    // 五档全部合法 —— 含新增的两档（更小 / 更大）
    expect(SIZE_PREFS.every(isSizePref)).toBe(true)
    expect(['xs', 's', 'm', 'l', 'xl'].every(isSizePref)).toBe(true)
    // 旧三档仍是合法值：存储里已有的 `{"size":"l"}` 不需要任何迁移
    expect(['s', 'm', 'l'].every(isSizePref)).toBe(true)
    expect(isSizePref('xxl')).toBe(false)
    expect(isSizePref('huge')).toBe(false)
    expect(isSizePref(undefined)).toBe(false)
  })

  /**
   * 五档的**两份约定**（`lib/prefs.ts` 的取值 ↔ `theme.css` 的 `--fs`）必须一一对应。
   *
   * 为何值得直接读 CSS 来对：少一条 `:root[data-size]` 规则 = 那一档选中后**没有任何缩放**
   * （页面看着就像「点了没反应」），而类型检查与组件用例都看不见 —— 它们只关心「属性写对没写对」。
   */
  it('theme.css 每一档都有 --fs：取值非零、严格递增、中档恒为 1', () => {
    // jsdom 环境下 `import.meta.url` 不是 file:// 协议，所以按仓库根取（vitest 的 cwd 就是它）
    const css = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8')
    const found = [...css.matchAll(/:root\[data-size='([a-z]+)'\]\s*\{\s*--fs:\s*([\d.]+);/g)]
    // 顺序也要一致：面板里的顺序就是它（由小到大）
    expect(found.map((m) => m[1])).toEqual([...SIZE_PREFS])
    const values = found.map((m) => Number(m[2]))
    expect(values.every((v) => Number.isFinite(v) && v > 0)).toBe(true)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!)
    }
    // 中档是默认值也是基准：改了它等于把所有用户的字号一起改了
    expect(values[SIZE_PREFS.indexOf('m')]).toBe(1)
  })

  it('resolveTheme：system 听系统的，显式选了就不听', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('prefs store —— 偏好落到 <html> 上', () => {
  it('默认「跟随系统」：手机是深色 → 页面 data-theme=dark', () => {
    stubMatchMedia(true)
    prefsStore.init()
    expect(root().dataset.theme).toBe('dark')
    expect(root().dataset.size).toBe('m')
  })

  it('显式选浅色后不再跟系统：系统换深色也不动', () => {
    const mql = stubMatchMedia(false)
    prefsStore.init()
    expect(root().dataset.theme).toBe('light')

    prefsStore.setTheme('light')
    mql.systemChange(true)
    expect(root().dataset.theme).toBe('light')
    // 显式档位不需要监听系统（留着一个监听器只是白耗）
    expect(mql.listenerCount()).toBe(0)
  })

  it('「跟随系统」时系统切主题会立刻生效', () => {
    const mql = stubMatchMedia(false)
    prefsStore.init()
    expect(root().dataset.theme).toBe('light')

    mql.systemChange(true)
    expect(root().dataset.theme).toBe('dark')
    mql.systemChange(false)
    expect(root().dataset.theme).toBe('light')
  })

  it('界面大小写进 data-size，并持久化（下次启动直接生效）', () => {
    stubMatchMedia(true)
    prefsStore.init()
    prefsStore.setSize('l')
    expect(root().dataset.size).toBe('l')
    expect(parsePrefs(localStorage.getItem(STORAGE_KEY)).size).toBe('l')

    // 换“一台设备”（清空内存）后重新 init：偏好还在
    prefsStore.reset()
    delete root().dataset.size
    prefsStore.init()
    expect(root().dataset.size).toBe('l')
  })

  it('localStorage 不可用（隐私模式）也不抛错：本次会话内照样能切', () => {
    stubMatchMedia(true)
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied')
      },
    })
    try {
      prefsStore.init()
      prefsStore.setTheme('light')
      expect(root().dataset.theme).toBe('light')
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
    }
  })
})
