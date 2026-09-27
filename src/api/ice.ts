/**
 * 手机端的 ICE 解析（§31）—— 共享包 `resolveIceServers()` 在本端的一层薄封装。
 *
 * 为什么还要包一层：手机端有两处要用（连接前、登录页的「高级设置」），而两边都要
 * **同一个 localStorage 口径**（自定义键 `virlen.rtc.ice`、缓存键 `virlen.rtc.ice.remote`）。
 * 逻辑本身不在这里 —— 优先级、降级、文案都在共享包里（与电脑端同一份）。
 *
 * 安全前提：**本端源码里没有任何 TURN 凭证**。默认值来自信令服务下发
 * （`GET <信令基址>/ice`），用户在登录页可以自己覆盖。
 */
import {
  ICE_CUSTOM_STORAGE_KEY,
  readCustomIceText,
  resolveIceServers,
  writeCustomIceText,
  type IceStoragePort,
  type ResolvedIceServers,
} from 'virlen-remote'

/** localStorage 端口（不可用时返回 `null` → 共享包自动降级为「不缓存」）。 */
function storage(): IceStoragePort | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** 最近一次解析结果（登录页的「当前生效」文案直接读它，避免为了显示再解析一遍）。 */
let lastResolved: ResolvedIceServers | null = null

export function lastIceResolution(): ResolvedIceServers | null {
  return lastResolved
}

/**
 * 解析本次连接要用的 ICE。
 *
 * @param signalUrl 信令基址（取自配对串 / 已配对设备记录）。缺省则不请求服务端，
 *                  只用「自定义 / 本地缓存」——同源 Broadcast 联调时正是这种情况。
 */
export async function resolveIceFor(signalUrl?: string): Promise<ResolvedIceServers> {
  const resolved = await resolveIceServers({
    ...(signalUrl ? { baseUrl: signalUrl } : {}),
    customText: storage()?.getItem(ICE_CUSTOM_STORAGE_KEY) ?? null,
    storage: storage(),
  })
  lastResolved = resolved
  return resolved
}

/** 文本框回填（已规范化；坏数据按「没填」处理）。 */
export function customIceText(): string {
  return readCustomIceText(storage())
}

/** 保存自定义 ICE（空 = 恢复服务端默认）。**先校验再落盘**，错误在保存那一刻暴露。 */
export function saveCustomIce(text: string): { ok: true } | { ok: false; error: string } {
  return writeCustomIceText(storage(), text)
}
