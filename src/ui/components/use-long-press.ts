/**
 * useLongPress —— 长按手势（手机端没有右键，长按就是它的「右键」）。
 *
 * ## 为什么不是一个 `onContextMenu`
 *
 * 长按在浏览器里的行为**因平台而异**：Android Chrome 会在约 500ms 时补发一个 `contextmenu`，
 * iOS Safari 不补（而是弹系统文本选择 / 呼出菜单）；桌面浏览器只认右键。只挂一个事件
 * 必然在一个平台上失效。所以这里：**touch 计时为主，`contextmenu` 为辅**（两者都通向同一个
 * 回调，重复触发是幂等的 —— 调用方只是把「当前长按的那条消息」记下来）。
 *
 * ## 两个必须处理的细节（不处理就是「点了没反应」或「误触」）
 *
 * 1. **滚动即取消**：手指一移动就说明用户是在滑列表。所以监听 `touchmove`，位移超过
 *    `LONG_PRESS_MOVE_PX` 就撤销计时 —— 否则轻轻一滑就把菜单弹出来。
 * 2. **抑制尾随的 `click`**：长按抬手后浏览器仍会补一个 `click`。而被长按的目标里
 *    **有按钮**（工具卡的展开头）：不抑制的话，长按会「弹菜单 + 顺手把卡片展开了」。
 *    这里用 `onClickCapture` 在**捕获阶段**把它吃掉（早于那个按钮自己的 `onClick`）。
 *    抑制窗口用**时间戳**而不是布尔标志：Android 的 `contextmenu` 与 iOS 的 `click`
 *    到达顺序不确定，布尔标志会漏一次或吃掉下一次正常点击（时间窗能自愈）。
 */
import { useCallback, useEffect, useRef, type MouseEvent, type TouchEvent } from 'react'

/** 长按判定时长（ms）。太短会与滚动冲突，太长会让人以为没反应。 */
export const LONG_PRESS_MS = 450

/** 手指位移超过这个像素数就当成滚动 / 拖动，撤销长按计时。 */
export const LONG_PRESS_MOVE_PX = 10

/**
 * 长按之后抑制 `click` 的时间窗（ms）。
 *
 * 覆盖「抬手 → 浏览器补发 click」这段延迟即可；给得太久会连累用户的下一次正常点击。
 */
export const CLICK_SUPPRESS_MS = 700

export interface LongPressHandlers {
  onTouchStart: (e: TouchEvent) => void
  onTouchMove: (e: TouchEvent) => void
  onTouchEnd: () => void
  onTouchCancel: () => void
  onContextMenu: (e: MouseEvent) => void
  onClickCapture: (e: MouseEvent) => void
}

/**
 * 返回一组要摊在**同一个元素**上的事件处理器（调用方 `{...longPress}` 即可）。
 *
 * `onLongPress` 不必保持引用稳定（内部用 ref 持有最新的那个）：行组件是 `memo` 的，
 * 传出稳定的回调是**调用方**的责任（见 `MessageList`）。
 */
export function useLongPress(onLongPress: () => void): LongPressHandlers {
  const handlerRef = useRef(onLongPress)
  handlerRef.current = onLongPress

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 起手坐标（用来判「这是滑动还是长按」）。 */
  const originRef = useRef<{ x: number; y: number } | null>(null)
  /** 最近一次「长按已触发」的时刻（0 = 还没触发过）。 */
  const firedAtRef = useRef(0)

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    originRef.current = null
  }, [])

  // 卸载时清掉挂起的计时器：否则「长按中切走会话」会在已卸载的行上回调
  useEffect(() => cancel, [cancel])

  const onTouchStart = useCallback(
    (e: TouchEvent) => {
      // 多指（捏合 / 双指滑动）一律不当长按
      if (e.touches.length > 1) {
        cancel()
        return
      }
      const touch = e.touches[0]
      originRef.current = { x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 }
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        firedAtRef.current = Date.now()
        handlerRef.current()
      }, LONG_PRESS_MS)
    },
    [cancel],
  )

  const onTouchMove = useCallback(
    (e: TouchEvent) => {
      const origin = originRef.current
      if (!origin) return
      const touch = e.touches[0]
      if (!touch) return
      const moved =
        Math.abs(touch.clientX - origin.x) > LONG_PRESS_MOVE_PX ||
        Math.abs(touch.clientY - origin.y) > LONG_PRESS_MOVE_PX
      if (moved) cancel()
    },
    [cancel],
  )

  const onTouchEnd = useCallback(() => {
    // 只撤销**尚未触发**的计时；已触发的要留着让下面的 click 抑制生效（见文件头 §2）
    if (timerRef.current !== null) cancel()
  }, [cancel])

  const onContextMenu = useCallback((e: MouseEvent) => {
    // 拦下浏览器自己的菜单 / 文本选择呼出（我们的面板就是它的替代品）
    e.preventDefault()
    firedAtRef.current = Date.now()
    handlerRef.current()
  }, [])

  const onClickCapture = useCallback((e: MouseEvent) => {
    if (Date.now() - firedAtRef.current > CLICK_SUPPRESS_MS) return
    e.preventDefault()
    e.stopPropagation()
  }, [])

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd, onContextMenu, onClickCapture }
}
