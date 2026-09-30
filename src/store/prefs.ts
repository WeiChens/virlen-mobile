/**
 * 界面偏好 store（主题 / 界面大小）—— 把 `lib/prefs.ts` 的纯逻辑落到 DOM 上。
 *
 * ## 为什么落 DOM 属性而不是给根元素加 class
 *
 * 主题 / 大小都是**全局唯一**的状态，`<html data-theme="light" data-size="l">` 一行就能表达，
 * 而且 CSS 侧的选择器与属性一一对应（`:root[data-theme='light']`）；换 class 只是换个写法，
 * 却要额外维护「同一时刻只有一个 class」这条不变量。
 *
 * ## 谁负责写 DOM
 *
 * 只有本 store。组件（顶栏那个齿轮 / 设置面板）只调 `setTheme` / `setSize`，
 * 绝不自己碰 `document.documentElement` —— 否则「面板里显示浅色、页面还是深色」这类
 * 不一致迟早出现，而且极难查（改一处生效，另一处不生效）。
 */
import { Store } from '../lib/store'
import {
  DEFAULT_PREFS,
  THEME_COLOR,
  parsePrefs,
  resolveTheme,
  serializePrefs,
  type ResolvedTheme,
  type SizePref,
  type ThemePref,
  type UiPrefs,
} from '../lib/prefs'

const STORAGE_KEY = 'virlen.mobile.ui-prefs'

/** 系统深色偏好的查询串（`matchMedia` 在 jsdom 里不存在，故所有调用点都要判空）。 */
const DARK_QUERY = '(prefers-color-scheme: dark)'

function read(): UiPrefs {
  try {
    return parsePrefs(localStorage.getItem(STORAGE_KEY))
  } catch {
    /* 隐私模式 / 读取被拒：用默认值，本次会话内仍可切换 */
    return DEFAULT_PREFS
  }
}

function write(prefs: UiPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializePrefs(prefs))
  } catch {
    /* 同上：写不进去不影响本次会话 */
  }
}

function prefersDark(): boolean {
  try {
    return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia(DARK_QUERY).matches
  } catch {
    return false
  }
}

class PrefsStore extends Store<UiPrefs> {
  /** 系统主题变化的订阅（只在 `theme: 'system'` 时有意义）。 */
  private offSystem: (() => void) | null = null

  constructor() {
    super(read())
  }

  /**
   * 启动时调用一次（`main.tsx` 里**渲染之前**）：把持久化的偏好读进来并写进 DOM，
   * 并视需要订阅系统主题。
   *
   * 为什么在渲染前：晚一步就会出现「先闪一下深色，再变成浅色」——手机上这个闪烁
   * 格外刺眼（地址栏 / 状态栏颜色也会跟着跳）。
   *
   * 为什么这里再读一次存储：构造函数跑在**模块加载**那一刻，而 `init()` 是真正的
   * 「启动」——两者之间可能隔了别的代码（测试里就是 `reset()`）。以存储为准，
   * `init()` 才能重复调用而不产生歧义。
   */
  init(): void {
    this.setState(read())
    this.apply()
    this.watchSystem()
  }

  setTheme(theme: ThemePref): void {
    this.update({ theme })
  }

  setSize(size: SizePref): void {
    this.update({ size })
  }

  /** 测试用：回到默认（生产不调用）。 */
  reset(): void {
    this.offSystem?.()
    this.offSystem = null
    this.setState(DEFAULT_PREFS)
  }

  private update(patch: Partial<UiPrefs>): void {
    const next = { ...this.getSnapshot(), ...patch }
    write(next)
    this.setState(next)
    this.apply()
    // 「跟随系统」是唯一需要听的档位：显式选了深浅之后，系统怎么变都不该影响本页
    this.watchSystem()
  }

  /** 偏好 → DOM（属性 + 地址栏主题色）。 */
  private apply(): void {
    const prefs = this.getSnapshot()
    const theme = resolveTheme(prefs.theme, prefersDark())
    const root = globalThis.document?.documentElement
    if (!root) return
    root.dataset.theme = theme
    root.dataset.size = prefs.size
    // 不换这个 meta，浅色主题下浏览器的状态栏 / 地址栏还是黑的（PWA 里尤其明显）
    const meta = globalThis.document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    meta?.setAttribute('content', THEME_COLOR[theme])
  }

  private watchSystem(): void {
    this.offSystem?.()
    this.offSystem = null
    if (this.getSnapshot().theme !== 'system') return
    if (typeof globalThis.matchMedia !== 'function') return
    const mql = globalThis.matchMedia(DARK_QUERY)
    // 老 Safari 只有 `addListener`（已废弃但仍在跑）
    const listener = (): void => this.apply()
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', listener)
      this.offSystem = () => mql.removeEventListener('change', listener)
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(listener)
      this.offSystem = () => mql.removeListener(listener)
    }
  }
}

export const prefsStore = new PrefsStore()

/** 当前生效的主题（`system` 已解析）——供 UI 显示「现在是深色还是浅色」。 */
export function effectiveTheme(prefs: UiPrefs, prefersDarkNow = prefersDark()): ResolvedTheme {
  return resolveTheme(prefs.theme, prefersDarkNow)
}
