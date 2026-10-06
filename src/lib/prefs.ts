/**
 * 界面偏好（主题 / 界面大小）—— **纯函数 + 存储口径**，可单测（§21.4）。
 *
 * 两个偏好都是**有限枚举**（主题三选一、界面大小五档），因此存的是枚举而不是布尔：
 * 布尔迟早要加上第三个值（主题就有第三个：「跟随系统」），那时存量的 `true/false` 就得做迁移
 * —— 一次说清更省事（后来「小 / 中 / 大」变五档也印证了这一点：多两个取值，存储格式一字不用改）。
 *
 * ⚠️ 与 `theme.css` 的**两份约定**（改一处必须改另一处）：
 * - `SIZE_PREF` 的取值 = `:root[data-size='…']` 的属性值；
 * - `ResolvedTheme` 的取值 = `:root[data-theme='…']` 的属性值。
 *   偏偏「属性名 → 色值」的映射只能写在 CSS 里（JS 不该知道任何颜色），所以这里放的是
 *   一个**纯函数 + 常量**，由 `store/prefs.ts` 落到 DOM 属性上。
 */

/** 用户选的主题：跟随系统 / 强制浅色 / 强制深色。 */
export type ThemePref = 'system' | 'light' | 'dark'
/**
 * 界面大小五档（对应 `:root[data-size]`），取值方向即 `SIZE_PREFS` 的顺序（从小到大）。
 *
 * 为何是五档而不是三档：真机反馈「还想再小一点」—— 旧「小」（0.92）在长命令 / 长表格面前仍偏大，
 * 而字号不能靠浏览器缩放去绕（那会把 `position: fixed` 的抽屉 / 底部面板一起缩，版式就跑偏了）。
 * 所以往**小**的一侧多给一档（特小 0.80），往大的一侧也多给一档（特大 1.26）。
 *
 * ⚠️ **中档恒为 1**：它既是现有用户的默认值（`DEFAULT_PREFS`），也是「不大不小」的基准 ——
 * 其余四档围绕它取值。同理 `'s'` / `'m'` / `'l'` 三个取值**沿用旧名**，于是存储里已有的
 * `{"size":"l"}` 不需要任何迁移就能继续生效（伪迁移是这类改动最容易出的事故：
 * 一个字面量改错，所有老用户的分档集体回落默认）。
 */
export type SizePref = 'xs' | 's' | 'm' | 'l' | 'xl'
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
/** 五档（顺序 = 设置面板里的顺序 = 字号由小到大）。 */
export const SIZE_PREFS: readonly SizePref[] = ['xs', 's', 'm', 'l', 'xl']

export function isThemePref(value: unknown): value is ThemePref {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function isSizePref(value: unknown): value is SizePref {
  return value === 'xs' || value === 's' || value === 'm' || value === 'l' || value === 'xl'
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
