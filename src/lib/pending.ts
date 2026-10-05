/**
 * 「慢才转圈」—— 所有「等返回值」的 UI 反馈统一走这里。
 *
 * ## 为什么需要它
 *
 * 手机上没有 hover、也没有指针，所以每个要等返回值的按钮都得有在途反馈（约定与样式见
 * `index.css` 的 `.spinner`）。但反过来也一样糟：**网络好的时候，loading 闪一下反而更慢**。
 * 一次 40ms 的请求如果先画出一个转圈、下一帧又抹掉它，用户看到的是「抖了一下」——
 * 比「什么都没发生、结果直接出现」显得更卡。
 *
 * 阈值就取在 100ms 附近：短于它的等待人眼基本记不住；长于它的等待没有反馈，就会被当成卡死。
 * （与 `index.css` 里 `prefers-reduced-motion` 那段的取舍是同一个立场：动画要么承载信息，
 * 要么干脆别出现。）
 *
 * ## 一把尺子量两件事：视觉可以等，拦截不能等
 *
 * | 返回值 | 什么时候为真 | 用来干什么 |
 * |---|---|---|
 * | `pending` | **慢才为真**（超过 `delayMs` 还没回来） | 转圈、「…中」文案 |
 * | `busy` | **立刻为真**（按下就在途） | 置灰、`aria-busy`、挡重复提交 |
 *
 * 那 100ms 里用户要是又点了一下（连击 / 手滑），必须被挡住 —— 挡它的**不是** `disabled`
 * （那要等下一帧），而是 `run` 里那把同步的闸刀：`run` 返回 `false` = 这次点击整个丢掉了。
 * 调用方据此就能在「改输入框 / 收起面板」之前决定要不要继续（否则会出现「字清空了、
 * 消息没发出去」）。
 *
 * ⚠️ 与之配套的一条纪律：`pending` 永远只表达「这次**真的慢了**」，不表达「请求发出去了」。
 * 所以别把 `pending` 拿去当 `disabled` 用（那会让快请求也闪一下置灰），也别用 `busy` 去决定
 * 转圈（那等于把这个文件白写了）。
 *
 * ## 两个入口
 *
 * - `usePending<K>()`：动作由**点击**发起（发送 / 停止 / 重连 / 应答 / 置顶 / 连接电脑…），
 *   `run(key, task)` 一把包住「拦截 → 起延时 → 转圈 → 收尾」；
 * - `useDelayedFlag(flag)`：在途状态**已经在 store 里**（`loadingMessages` / `loadingOlder` /
 *   `loadingSessions` / 候选集加载），只把「显示不显示」推迟 —— store 不必为观感改一行。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 阈值（ms）：短于它的操作一律不显示 loading。
 *
 * 100 是「感知为瞬时」与「开始怀疑卡死」之间那条线 —— 比它更短会闪，更长会让人对着不动的
 * 界面等。要按场景调就传给钩子（`usePending(300)`），别改这里：改这里等于改全站的手感。
 */
export const LOADING_DELAY_MS = 100

export interface Pending<K> {
  /** **慢才为真**：这次动作超过阈值还没回来 → 该转圈了。UI 只看它。 */
  pending: K | null
  /** **立刻为真**：有动作在途 → 该置灰、该挡住下一次点击。 */
  busy: boolean
  /**
   * 跑一次「等返回值」的动作。
   *
   * @returns 这次点击**是否被受理**。`false` = 已有动作在途（闸刀当场把它丢掉了），
   *          调用方**什么都别做**（不要清输入框、不要收面板）。
   *
   * @param key  用来区分「哪一颗在转圈」；同一个动作只有一种长相就传常量。
   * @param task 真正那个请求。它的 Promise 结束（成功或失败）即为收尾。
   * @param done 收尾动作（如「删完收起面板」），在 `task` 之后、清状态之前跑。
   */
  run: (key: K, task: () => Promise<unknown>, done?: () => void) => boolean
}

/**
 * 把「一次点击发起的一次等待」变成可渲染的状态（见文件头）。
 *
 * ⚠️ 一个钩子实例 = 一把闸刀：同一个面板里的多个动作共用一个实例即可（它们本来就该互斥）。
 * 真要让两件事并行（各转各的圈），就用两个实例 —— 但先想清楚那两件事是否真的可以同时在飞。
 */
export function usePending<K>(delayMs: number = LOADING_DELAY_MS): Pending<K> {
  const [pending, setPending] = useState<K | null>(null)
  const [busy, setBusy] = useState(false)
  /** 延时器（慢才转圈就靠它）。 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 同步闸刀：`busy` 是渲染用的副本，挡点击必须靠它（不依赖下一帧）。 */
  const runningRef = useRef(false)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // 卸载时清掉挂起的延时器（否则会在已卸载的组件上 setState）
  useEffect(() => clearTimer, [clearTimer])

  const run = useCallback(
    (key: K, task: () => Promise<unknown>, done?: () => void): boolean => {
      if (runningRef.current) return false
      runningRef.current = true
      setBusy(true)
      /*
       * 延时的意义全在这一句：**先只起一个计时器**。任务在计时器到期之前回来时，
       * `pending` 从头到尾没被置起 → 一次渲染都不多 → 界面上什么都没闪过。
       */
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setPending(key)
      }, delayMs)
      void task()
        .then(() => done?.())
        .catch((err: unknown) => {
          /*
           * 只保证不再往外抛：`void` 掉的那个 Promise 一 reject 就是 unhandled rejection，
           * 而这里**不是**报错的地方 —— 本仓的 store 方法都是「自己吞错误 + 置一条 error 提示」，
           * 界面上的错误条才是用户该看到的那个东西。
           */
          console.error('[virlen] 在途动作失败：', err)
        })
        .finally(() => {
          clearTimer()
          runningRef.current = false
          setBusy(false)
          setPending(null)
        })
      return true
    },
    [delayMs, clearTimer],
  )

  return { pending, busy, run }
}

/**
 * 「这个在途状态**慢**了吗」—— 给**已经在 store 里**的在途标志用（见文件头）。
 *
 * 与 `usePending` 的区别：这边不管理动作，只回答一个问题 —— 那个已经为真的标志，值得
 * 现在就画出来吗？当 `active` 在阈值内落回 false 时，返回值**一次都不会为真**。
 *
 * ⚠️ 调用方要自己保证「不显示 loading 的那段时间里别说出别的话」：例如候选列表在
 * 「正在拉」与「电脑侧一个都没有」之间选文案时，那 100ms 里只能**什么都不说**（返回 `null`），
 * 不能说「没有」—— 那是对这 100ms 的假话。
 */
export function useDelayedFlag(active: boolean, delayMs: number = LOADING_DELAY_MS): boolean {
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    if (!active) {
      // 已经结束了（或压根没开始）：立刻收回。`slow` 本就是 false 时 React 会跳过重渲染
      setSlow(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), delayMs)
    // 提前结束（`active` 变 false / 卸载）→ 计时器作废，`slow` 永远没机会为真
    return () => clearTimeout(timer)
  }, [active, delayMs])

  return slow
}
