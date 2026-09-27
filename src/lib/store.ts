/**
 * 极简可订阅 store（手机端无 mobx 依赖，用 `useSyncExternalStore` 桥接 React）。
 */
import { useSyncExternalStore } from 'react'

export type Unsubscribe = () => void
export type Listener = () => void

export class Store<T> {
  private readonly listeners = new Set<Listener>()
  private state: T

  constructor(initial: T) {
    this.state = initial
  }

  readonly getSnapshot = (): T => this.state

  readonly subscribe = (listener: Listener): Unsubscribe => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  protected setState(next: T | ((prev: T) => T)): void {
    const value = typeof next === 'function' ? (next as (prev: T) => T)(this.state) : next
    if (Object.is(value, this.state)) return
    this.state = value
    for (const listener of [...this.listeners]) listener()
  }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/**
 * 切片订阅 —— 只订阅 store 里的**一个切片**，该切片没变就不重渲染。
 *
 * ⚠️ 铁律：`selector` **必须返回 state 里既有的引用或原始值**，不得每次新建对象 / 数组。
 *   反例：`(s) => s.messages[s.currentSessionId] ?? []` —— 会话不存在时每次返回**新数组**，
 *   React 会判定「快照一直在变」→ 无休止重渲染。回退值请用模块级常量。
 *   （本函数不给 selector 加缓存/浅比较，就是为了让这条铁律在**类型与代码上都看得见**。）
 *
 * 为什么需要它（§29）：流式正文每帧都改 `state.streaming`，而 `useStore(chatStore)` 订阅的是
 * **整个 state** —— 于是「一个 token」会重渲染整个聊天页。把高频切片下沉到真正消费它的叶子
 * 组件后，每帧只有那个叶子重渲染。
 */
export function useStoreSelector<T, S>(store: Store<T>, selector: (state: T) => S): S {
  const getSnapshot = (): S => selector(store.getSnapshot())
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}
