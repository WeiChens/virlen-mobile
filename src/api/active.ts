/**
 * 当前活动连接（Endpoint / caller）的持有者。
 *
 * 独立成模块以避免 `connection` 与 `chat` 之间的循环依赖：
 * 两者都只依赖本模块。
 */
import type { Endpoint, HostApi, TypedCaller } from 'virlen-remote'

let caller: TypedCaller<HostApi> | null = null
let endpoint: Endpoint | null = null

const readyHandlers = new Set<(endpoint: Endpoint) => void>()

export function setActive(ep: Endpoint, c: TypedCaller<HostApi>): void {
  endpoint = ep
  caller = c
  for (const handler of [...readyHandlers]) handler(ep)
}

export function clearActive(): void {
  endpoint = null
  caller = null
}

export function getEndpoint(): Endpoint | null {
  return endpoint
}

export function getCaller(): TypedCaller<HostApi> {
  if (!caller) throw new Error('未连接到电脑')
  return caller
}

/** 连接就绪时回调（用于挂载 host 事件订阅）。 */
export function onEndpointReady(handler: (endpoint: Endpoint) => void): () => void {
  readyHandlers.add(handler)
  return () => {
    readyHandlers.delete(handler)
  }
}
