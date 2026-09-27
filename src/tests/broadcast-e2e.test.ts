/**
 * 手机端 ↔ 跨 tab 真实链路 e2e —— **走浏览器完全相同的代码路径**。
 *
 * 与 `mobile-stores.test.ts` 的差异：那边用 `memory transport` 注入；这边**不注入**，
 * 让 `connectionStore` 走真实的 `createTransport`（默认 `BroadcastChannel`），
 * 对端是真实的 `registerHostHandlers` 胶水（mock 数据源）—— 因而一并验证了
 * **频道名派生 / 载荷对齐 / whenReady / 事件订阅**这些"接线"部分。
 *
 * ⚠️ **必须 node 环境**：jsdom 与 Node 的 `Uint8Array` 属不同 realm，而 jsdom 未实现
 * `BroadcastChannel`（用的是 Node 的）→ 反序列化出的 `Uint8Array` 在 jsdom realm 下
 * `instanceof` 为 false，帧会被 `toBytes` 丢弃。真实浏览器同 realm，无此问题。
 */
// @vitest-environment node

// 必须第一个 import：在 store 模块（devices 等）加载前补上 localStorage
import './support/node-env'

import { describe, it, expect, afterEach } from 'vitest'
import { BroadcastTransport, Endpoint, registerHostHandlers } from 'virlen-remote'
import { createMockHostDataSource } from 'virlen-remote/testing'
import { channelNameFor } from '../api/transport'
import { connectionStore } from '../store/connection'
import { chatStore } from '../store/chat'
import { devicesStore } from '../store/devices'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let hostEndpoint: Endpoint | null = null
let hostTransport: BroadcastTransport | null = null

afterEach(() => {
  connectionStore.disconnect()
  hostEndpoint?.dispose()
  hostTransport?.close()
  hostEndpoint = null
  hostTransport = null
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
})

describe('跨 tab 真实链路 e2e（BroadcastChannel）', () => {
  it('连接 → 会话列表 → 打开会话 → 发消息 → 收流式 → 完整消息收口', async () => {
    const hostId = `demo-host-${Math.random().toString(36).slice(2)}`
    const channel = channelNameFor(hostId)

    // ---- 电脑侧：真实 bridge 胶水 + mock 数据源 ----
    hostTransport = new BroadcastTransport(channel)
    hostEndpoint = new Endpoint({ transport: hostTransport })
    const source = createMockHostDataSource({ streamSteps: 3, streamDelayMs: 10 })
    const reg = registerHostHandlers(hostEndpoint, source)
    source.bind((topic, payload) => reg.emit(topic, payload))

    // ---- 手机侧：真实 connectionStore，**不注入 transport**（走真实 createTransport）----
    const ok = await connectionStore.connect({
      hostId,
      deviceName: 'Virlen 电脑（演示）',
      token: 'demo-ticket',
    })
    expect(ok).toBe(true)
    expect(connectionStore.getSnapshot().status).toBe('online')

    // 已配对设备被记录
    expect(devicesStore.getSnapshot().some((d) => d.name === 'Virlen 电脑（演示）')).toBe(true)

    // 会话列表
    await chatStore.loadSessions()
    const sessions = chatStore.getSnapshot().sessions
    expect(sessions.length).toBeGreaterThan(0)

    // 打开首个会话（触发 host.session.messages + host.session.subscribe）
    const sid = sessions[0].id
    await chatStore.openSession(sid)
    const firstCount = chatStore.getSnapshot().messages[sid]?.length ?? 0

    // 发消息：RPC 只回投递确认，过程走事件
    await chatStore.send('你好，Agent')
    await flush(120)

    const snap = chatStore.getSnapshot()
    const msgs = snap.messages[sid] ?? []
    // 至少多了「用户消息」与「AI 完整消息」
    expect(msgs.length).toBeGreaterThan(firstCount)
    expect(msgs.some((m) => m.role === 'user' && m.text.includes('你好'))).toBe(true)
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true)
    // 流式已收口（final 与 added 到达后清空）
    expect(snap.streaming[sid]).toBeUndefined()

    // 断开 → 回到登录页，缓存清空
    connectionStore.disconnect()
    expect(connectionStore.getSnapshot().status).toBe('idle')
    expect(chatStore.getSnapshot().sessions.length).toBe(0)
  })
})
