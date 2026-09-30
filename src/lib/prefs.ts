/**
 * 界面偏好（主题 / 界面大小）—— **纯函数 + 存储口径**，可单测（§21.4）。
 *
 * 两个偏好都只有「三选一」，因此存的是**枚举**而不是布尔：布尔迟早要加上第三个值
 * （主题就有第三个：「跟随系统」），那时存量的 `true/false` 就得做迁移 —— 一次说清更省事。
 *
 * ⚠️ 与 `theme.css` 的**两份约定**（改一处必须改另一处）：
 * - `SIZE_PREF` 的取值 = `:root[data-size='…']` 的属性值；
 * - `ResolvedTheme` 的取值 = `:root[data-theme='…']` 的属性值。
 *   偏偏「属性名 → 色值」的映射只能写在 CSS 里（JS 不该知道任何颜色），所以这里放的是
 *   一个**纯函数 + 常量**，由 `store/prefs.ts` 落到 DOM 属性上。
 */

/** 用户选的主题：跟随系统 / 强制浅色 / 强制深色。 */
export type ThemePref = 'system' | 'light' | 'dark'
/** 界面大小三档（对应 `:root[data-size]`）。 */
export type SizePref = 's' | 'm' | 'l'
/** 实际生效的主题（`system` 解析之后的结果），对应 `:root[data-theme]`。 */
export type ResolvedTheme = 'light' | 'dark'

export interface UiPrefs {
  theme: ThemePref
  size: SizePref
}

/**
 * 默认值：**跟系统 + 中号**。
 *
 * 为什么默认「跟随系统」而不是「深色」：手机端本来就是深色写死；改成可切换之后，用户的
 * 第一直觉是「我手机是深色，它就是深色」。默认深色会在浅色手机上看成一个「不合群的应用」。
 */
export const DEFAULT_PREFS: UiPrefs = { theme: 'system', size: 'm' }

export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark']
export const SIZE_PREFS: readonly SizePref[] = ['s', 'm', 'l']

export function isThemePref(value: unknown): value is ThemePref {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function isSizePref(value: unknown): value is SizePref {
  return value === 's' || value === 'm' || value === 'l'
}

/**
 * 解析存储值：**坏数据一律退回默认**（不抛错、不半信半疑地猜）。
 *
 * 存储里可能是老版本写的、用户手改的、或被别的脚本污染的 JSON —— 这里只要能回答
 * 「两个字段各自合法吗」，任一非法就只回退那一个字段（另一个仍然生效）。
 */
export function parsePrefs(raw: string | null | undefined): UiPrefs {
  if (!raw) return DEFAULT_PREFS
  try {
    const obj = JSON.parse(raw) as Partial<UiPrefs>
    return {
      theme: isThemePref(obj.theme) ? obj.theme : DEFAULT_PREFS.theme,
      size: isSizePref(obj.size) ? obj.size : DEFAULT_PREFS.size,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function serializePrefs(prefs: UiPrefs): string {
  return JSON.stringify({ theme: prefs.theme, size: prefs.size })
}

/**
 * `system` → 交给系统的判定；显式选了浅色 / 深色就**不听系统**。
 *
 * 单独抽成纯函数是为了能在单测里把「系统现在是什么」当成参数传进来 ——
 * 组件里读 `matchMedia` 的代码没有任何可测的分支。
 */
export function resolveTheme(pref: ThemePref, prefersDark: boolean): ResolvedTheme {
  if (pref === 'dark') return 'dark'
  if (pref === 'light') return 'light'
  return prefersDark ? 'dark' : 'light'
}

/** 主题 → 浏览器地址栏 / 状态栏的颜色（`<meta name="theme-color">`）。 */
export const THEME_COLOR: Record<ResolvedTheme, string> = {
  dark: '#0f0f10',
  light: '#f2f2f6',
}
