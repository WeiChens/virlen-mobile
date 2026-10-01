import { useEffect, useRef } from 'react'

/**
 * 倒置列表（V6）的滚动底座：贴底跟随 + 漂移纠正。
 *
 * 移植自参考项目 `react虚拟列表前向插入/src/lists/shared/stick.ts`，只保留**倒置坐标系**
 * （`scrollTop` 0 = 视觉底部）这一支。
 *
 * ## 为什么倒置架构仍需「漂移纠正」
 *
 * 镜像容器里视觉底部对应内容坐标的**起点**。当最新一条（视觉底部）长高 `delta`，
 * 后续所有元素在内容坐标里都后移 `delta`，于是屏幕上已显示的内容整体上移。
 * 正序列表没有这个问题（底部增长不影响上方元素的内容坐标），所以只有倒置实现需要它。
 *
 * 统一公式（正序与倒置都成立）：`scrollTop += 锚点当前屏幕偏移 − 基线屏幕偏移`。
 */

const MID_ATTR = 'data-mid'

export function maxScrollTop(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

interface AnchorHit {
  el: HTMLElement
  id: string
  /** 元素 top 相对滚动容器视口 top 的偏移；负数代表被上边缘裁掉一部分。 */
  deltaTop: number
}

/**
 * 取「屏幕上最靠上、且与视口相交」的行元素。
 * 刻意按**屏幕坐标**而不是 DOM 顺序挑选 —— 镜像容器（`scaleY(-1)`）下 DOM 顺序与视觉顺序相反。
 */
function pickTopVisible(scroller: HTMLElement): AnchorHit | null {
  const vp = scroller.getBoundingClientRect()
  const nodes = scroller.querySelectorAll<HTMLElement>(`[${MID_ATTR}]`)
  let best: AnchorHit | null = null
  let bestTop = Number.POSITIVE_INFINITY
  for (const el of nodes) {
    const rect = el.getBoundingClientRect()
    if (rect.bottom <= vp.top + 1 || rect.top >= vp.bottom - 1) continue // 与视口不相交
    if (rect.top < bestTop) {
      bestTop = rect.top
      best = { el, id: el.dataset.mid ?? '', deltaTop: rect.top - vp.top }
    }
  }
  return best
}

function findMessageEl(scroller: HTMLElement, id: string): HTMLElement | null {
  const safe = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"')
  return scroller.querySelector<HTMLElement>(`[${MID_ATTR}="${safe}"]`)
}

function deltaTopOf(scroller: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
}

/** 锚点：某个行 key + 它当时的「距视口顶部偏移」（**视觉**坐标，负 = 被上边缘裁掉一部分）。 */
export interface Anchor {
  id: string
  deltaTop: number
}

/** 记录「屏幕上最靠上的一个气泡」作为锚点 —— 加载更多前后用它归位（`restoreAnchor`）。 */
export function captureTopAnchor(scroller: HTMLElement): Anchor | null {
  const hit = pickTopVisible(scroller)
  return hit ? { id: hit.id, deltaTop: hit.deltaTop } : null
}

/**
 * 实测 `deltaTop` 对 `scrollTop` 的响应系数：`d(deltaTop)/d(scrollTop)`。
 *
 * 为什么用「实测」而不是写死符号：本项目给滚动容器加了 `transform: scaleY(-1)`（倒置列表），
 * `getBoundingClientRect().top` 拿到的是**镜像之后**的视觉坐标，`ΔdeltaTop` 与 `scrollTop`
 * 的符号关系不再是常规的 `-1`。写死符号会让补偿方向反掉 —— 表现正是「越补越偏，还剩一点」。
 * 这里在**同一帧内**先小幅试探一次再复位，任何内核（正序 / 镜像）下都能拿到正确方向。
 */
function measureScrollResponse(
  scroller: HTMLElement,
  node: HTMLElement,
  baseTop: number,
  baseDelta: number
): number {
  const max = maxScrollTop(scroller)
  if (max < 1) return 0
  const probe = Math.min(24, max)
  // 靠近上界就往下探，否则往上探 —— 保证试探位移真正落进了可滚动范围
  const applied = baseTop + probe <= max ? probe : -probe
  const tentative = clamp(baseTop + applied, 0, max)
  const realDelta = tentative - baseTop
  if (Math.abs(realDelta) < 0.5) return 0
  scroller.scrollTop = tentative
  const probed = deltaTopOf(scroller, node)
  scroller.scrollTop = baseTop
  const response = (probed - baseDelta) / realDelta
  return Number.isFinite(response) ? response : 0
}

/**
 * 把锚点元素恢复到「距视口顶部 = `anchor.deltaTop`」的位置；返回写入的 `scrollTop` 位移。
 *
 * 铁律（与参考实现一致）：**只按「锚点元素 + 视口内偏移」求解，绝不用「总高度差」直接加减。**
 * 用总高度差：一旦估算不准 / 触到滚动边界被 clamp，就会跳到最底或最顶；
 * 用锚点求解：目标 `scrollTop = 当前值 − 偏移残差 / 方向系数`，天然带边界 clamp，误差不被放大。
 */
export function restoreAnchor(scroller: HTMLElement, anchor: Anchor): number {
  const node = findMessageEl(scroller, anchor.id)
  if (!node) return 0
  const baseTop = scroller.scrollTop
  const baseDelta = deltaTopOf(scroller, node)
  // 相对基线漂移了多少（视觉）：>0 = 往下走了，<0 = 往上走了
  const drift = baseDelta - anchor.deltaTop
  if (Math.abs(drift) < 0.5) return 0
  const response = measureScrollResponse(scroller, node, baseTop, baseDelta)
  if (Math.abs(response) < 1e-6) return 0
  const max = maxScrollTop(scroller)
  // 想让 deltaTop 恰好回到 anchor.deltaTop：需要 ΔdeltaTop = -drift = response * ΔscrollTop
  const target = clamp(baseTop - drift / response, 0, max)
  if (Math.abs(target - baseTop) < 0.5) return 0
  scroller.scrollTop = target
  return scroller.scrollTop - baseTop
}

/* ══════════════════ 贴底跟随 ══════════════════ */

export interface StickController {
  following(): boolean
  /** 内容变化后调用：仅在「应当跟随」时贴底；返回写入的 scrollTop 位移（未跟随恒为 0）。 */
  stick(): number
  /** 强制恢复跟随并立即贴底（发送消息 / 点「回到最新」）。 */
  forceFollow(behavior?: ScrollBehavior): void
  /** 主动放弃跟随（上拉续页 = 用户在翻历史）。 */
  pause(): void
}

export interface UseStickToBottomOptions {
  scroller: HTMLElement | null
  /** 距视觉底部不超过该像素数即视为「接近底部」。 */
  thresholdPx: number
  onFollowChange?: (following: boolean) => void
}

/** 程序写入 `scrollTop` 与 scroll 事件之间的容差：低于它视为同一次程序滚动。 */
const PROGRAMMATIC_EPS = 1.5

/**
 * 「接近底部就自动跟随」—— 三条铁律（见参考项目文件头）：
 *  1) 跟随判定用**几何距离 + 阈值**，不要用「严格到底」（流式每帧都在改高度，一帧就失效）；
 *  2) **区分程序滚动与用户滚动**（程序写 `scrollTop` 也会触发 scroll），否则跟随会自己断掉；
 *  3) **非跟随状态一个像素都不动**。
 */
export function useStickToBottom(opts: UseStickToBottomOptions): StickController {
  const { scroller } = opts
  // 其余选项（thresholdPx / onFollowChange）通过 ref 实时读取，避免选项变化反复解绑重绑。
  const optsRef = useRef(opts)
  optsRef.current = opts

  const stateRef = useRef<{
    following: boolean
    expectedTop: number | null
    suppressUntil: number
  } | null>(null)
  if (!stateRef.current) stateRef.current = { following: true, expectedTop: null, suppressUntil: 0 }
  const state = stateRef.current

  const emit = (next: boolean) => {
    if (state.following === next) return
    state.following = next
    optsRef.current.onFollowChange?.(next)
  }

  useEffect(() => {
    if (!scroller) return
    const onScroll = () => {
      if (state.suppressUntil > performance.now()) return
      const top = scroller.scrollTop
      const expected = state.expectedTop
      if (expected != null && Math.abs(top - expected) <= PROGRAMMATIC_EPS) return // 我们自己写的
      state.expectedTop = null
      // 倒置：视觉底部 = scrollTop 0，故「距底部距离」就是 scrollTop 本身
      emit(top <= optsRef.current.thresholdPx)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller])

  const ctlRef = useRef<StickController | null>(null)
  if (!ctlRef.current) {
    ctlRef.current = {
      following: () => state.following,
      stick: () => {
        const el = optsRef.current.scroller
        if (!el) return 0
        if (!state.following) return 0
        const before = el.scrollTop
        if (Math.abs(before) < 0.5) {
          state.expectedTop = 0
          return 0
        }
        el.scrollTop = 0 // 倒置：贴底 = 归零
        state.expectedTop = el.scrollTop
        return el.scrollTop - before
      },
      forceFollow: (behavior: ScrollBehavior = 'auto') => {
        emit(true)
        const el = optsRef.current.scroller
        if (!el) return
        if (behavior === 'auto') {
          el.scrollTop = 0
          state.expectedTop = el.scrollTop
        } else {
          // 平滑滚动期间会连续触发 scroll，几何判定会把中途位置误判成「用户上滑」，
          // 所以这段时间内只重建基线、不做跟随判定。
          state.expectedTop = null
          state.suppressUntil = performance.now() + 600
          el.scrollTo({ top: 0, behavior })
        }
      },
      pause: () => emit(false),
    }
  }
  return ctlRef.current
}

/* ══════════════════ 漂移纠正 ══════════════════ */

/**
 * 漂移守卫：内容发生不可预知的变化时，保证屏幕上已显示的锚点内容不移动。
 *
 * 基线在用户滚动时自动重建，所以中间插入的用户滚动不会污染判定；
 * `reset()` 供「显式锚点归位」之后重建基线用（避免下一次 sync 从旧基线起算）。
 */
export function useDriftGuard(opts: {
  scroller: HTMLElement | null
  isFollowing: () => boolean
}): { sync: () => number; reset: () => void } {
  const { scroller } = opts
  const optsRef = useRef(opts)
  optsRef.current = opts
  const baseRef = useRef<Anchor | null>(null)

  useEffect(() => {
    if (!scroller) return
    const capture = () => {
      baseRef.current = captureTopAnchor(scroller)
    }
    capture()
    scroller.addEventListener('scroll', capture, { passive: true })
    return () => scroller.removeEventListener('scroll', capture)
  }, [scroller])

  const ref = useRef<{ sync: () => number; reset: () => void } | null>(null)
  if (!ref.current) {
    ref.current = {
      reset: () => {
        const el = optsRef.current.scroller
        baseRef.current = el ? captureTopAnchor(el) : null
      },
      sync: () => {
        const el = optsRef.current.scroller
        if (!el) return 0
        // 跟随中：位置由「贴底」逻辑负责，这里只重建基线
        if (optsRef.current.isFollowing()) {
          baseRef.current = captureTopAnchor(el)
          return 0
        }
        const base = baseRef.current
        const moved = base ? restoreAnchor(el, base) : 0
        baseRef.current = captureTopAnchor(el)
        return moved
      },
    }
  }
  return ref.current
}
