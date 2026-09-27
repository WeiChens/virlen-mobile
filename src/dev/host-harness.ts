/**
 * 电脑模拟器（联调宿主）—— 仅 dev 使用（`/host.html`）。
 *
 * 两种模式（页面上可切换，或用 `?mode=` 指定）：
 *
 * - **`rtc`（默认）真机模式**：走公开信令服务 + WebRTC，**手机可跨设备连进来**。
 *   手机与电脑在同一台/不同设备都行。需要网络可达信令服务。
 * - **`broadcast` 联调模式**：`BroadcastChannel`，**仅同浏览器两个 tab**（不跨设备、不跨浏览器）。
 *
 * 用的都是**真实 bridge 代码**（`registerHostHandlers` + `HostDataSource` 端口），只把数据源换成 mock；
 * 真实桌面端（Tauri）换成接 `sessionStore` / `chat-service` 的数据源即可。
 *
 * URL 参数：`?mode=rtc|broadcast` `?signal=<基址>` `?room=<房间>` `?host=<电脑标识>`
 */
import QRCode from 'qrcode'
import {
  BroadcastTransport,
  Endpoint,
  RtcTransport,
  SseSignalingClient,
  registerHostHandlers,
  type Transport,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource } from 'virlen-remote/testing'
import { resolveIceFor } from '../api/ice'

type Mode = 'rtc' | 'broadcast'

const params = new URLSearchParams(location.search)
const HOST_ID = params.get('host') ?? 'virlen-demo-host'
const HOST_NAME = 'Virlen 电脑（演示）'
const SIGNAL_BASE = params.get('signal') ?? 'https://virlen.cn/api/rtc/'
const ROOM = params.get('room') ?? HOST_ID

/*
 * ICE 默认值来自信令服务（`GET <SIGNAL_BASE>ice`）—— 本文件里没有任何 TURN 凭证（§31）。
 * 与手机端走同一个解析入口（自定义 > 服务端下发 > 缓存 > 空）。
 */

let mode: Mode = params.get('mode') === 'broadcast' ? 'broadcast' : 'rtc'
let ticket = randomTicket()
let transport: Transport | null = null
let endpoint: Endpoint | null = null
let stopLink: (() => void) | null = null
/** 当前宿主数据源（供「模拟交互」按钮触发卡片）。 */
let hostSource: MockHostDataSource | null = null

// ---------------- DOM ----------------

const root = document.getElementById('host-root')
if (root) {
  root.innerHTML = `
    <h1>Virlen 电脑模拟器</h1>
    <div class="modes">
      <span>模式：</span>
      <button id="m-rtc" type="button">真机 RTC</button>
      <button id="m-bc" type="button">联调 Broadcast</button>
    </div>
    <p class="muted" id="mode-info"></p>
    <canvas id="qr"></canvas>
    <p class="muted">手机端打开 <code id="mobile-url"></code>，用「扫码」或「手动输入配对串」：</p>
    <pre id="payload"></pre>
    <div class="row">
      <button id="copy" type="button">复制配对串</button>
      <button id="regen" type="button">重新生成二维码</button>
    </div>
    <h2>模拟交互（验证手机端卡片）</h2>
    <p class="muted">
      点一下 = 电脑侧发起一次「待应答交互」，看手机上是否出现卡片、应答后是否被接受。
      分级（tier）在这里是**手写**的；真实分流逻辑在电脑侧 bridge（approval-policy.ts，已有单测覆盖）。
    </p>
    <div class="row">
      <button id="it-low" type="button">低风险命令</button>
      <button id="it-high" type="button">高风险（沙盒脱壳）</button>
      <button id="it-choice" type="button">AI 提问</button>
      <button id="it-term" type="button">终端内确认</button>
    </div>
    <h2>上下文占用（验证手机端信息面板）</h2>
    <p class="muted">
      「占用 75%」后手机端会话信息面板才会出现「压缩上下文」（与桌面 token 环同判据：低于 40% 不给压）。
      压缩后 mock 会把消息换成一条摘要 + 推 messages.reset，手机端应自动重拉。
    </p>
    <div class="row">
      <button id="ctx-low" type="button">占用 10%</button>
      <button id="ctx-high" type="button">占用 75%</button>
    </div>
    <h2>事件日志</h2>
    <pre id="log"></pre>
  `
}

const logEl = () => document.getElementById('log')
function log(line: string): void {
  const el = logEl()
  if (!el) return
  const time = new Date().toLocaleTimeString()
  el.textContent = `[${time}] ${line}\n${el.textContent ?? ''}`
}

// ---------------- 生命周期 ----------------

function stop(): void {
  stopLink?.()
  stopLink = null
  endpoint?.dispose()
  endpoint = null
  transport?.close()
  transport = null
}

async function start(): Promise<void> {
  stop()
  // `demoToolMessage`：给 demo-1 补一条带工具名的工具消息 + 一条空正文的 assistant 消息
  //（验证手机端的「工具 · list_files」气泡与「空气泡不渲染」两条规则）
  const source = createMockHostDataSource({
    streamSteps: 3,
    streamDelayMs: 60,
    demoToolMessage: true,
  })
  hostSource = source

  if (mode === 'rtc') {
    const ice = await resolveIceFor(SIGNAL_BASE)
    if (ice.servers.length === 0) log(`⚠️ ICE 未取到（${ice.detail}）—— 跨网可能连不上`)
    const signaling = new SseSignalingClient({ baseUrl: SIGNAL_BASE, room: ROOM, role: 'host' })
    transport = new RtcTransport({ role: 'host', signaling, iceServers: ice.servers })
  } else {
    transport = new BroadcastTransport(`virlen-remote:${HOST_ID}`)
  }

  endpoint = new Endpoint({ transport })

  // 联调诊断：把「收到的 RPC」打出来。否则只有出站事件日志，无法判断对端是否触达本机。
  const rawHandle = endpoint.handle.bind(endpoint)
  endpoint.handle = (method, fn) =>
    rawHandle(method, async (params, ctx) => {
      log(`← 调用 ${method}`)
      try {
        const result = await fn(params, ctx)
        log(`✓ 完成 ${method}`)
        return result
      } catch (e) {
        log(`✗ 失败 ${method}：${(e as Error)?.message ?? String(e)}`)
        throw e
      }
    })

  const registration = registerHostHandlers(endpoint, source)
  // 事件既推给手机、也打到日志，便于联调观察
  source.bind((topic, payload) => {
    log(`→ ${topic}`)
    registration.emit(topic, payload)
  })

  const offState = transport.onStateChange((s) => log(`链路状态：${s}`))
  const offError =
    transport instanceof RtcTransport ? transport.onError((e) => log(`链路错误：${e.message}`)) : () => {}
  stopLink = () => {
    offState()
    offError()
    registration.dispose()
  }

  if (mode === 'rtc') {
    log(`RTC host 启动 · 信令 ${SIGNAL_BASE} · 房间 ${ROOM}`)
    void transport.start?.()
  } else {
    log(`Broadcast 启动（仅同浏览器两 tab）· 频道 virlen-remote:${HOST_ID}`)
  }
}

// ---------------- 渲染 ----------------

function payload(): string {
  const base = { v: 1, host: HOST_ID, name: HOST_NAME, ticket }
  // RTC 模式必须带 signal + room，否则手机会退回 Broadcast（跨设备不通）
  return JSON.stringify(mode === 'rtc' ? { ...base, signal: SIGNAL_BASE, room: ROOM } : base)
}

function render(): void {
  const info = document.getElementById('mode-info')
  if (info) {
    info.textContent =
      mode === 'rtc'
        ? `真机 RTC：信令 ${SIGNAL_BASE} · 房间 ${ROOM}（手机需 HTTPS 才能用摄像头；也可手动输入）`
        : `联调 Broadcast：仅同一浏览器内的另一个 tab 可连（不跨设备）`
  }
  const mobileUrl = document.getElementById('mobile-url')
  if (mobileUrl) mobileUrl.textContent = `https://${location.hostname}:5173/`

  const canvas = document.getElementById('qr') as HTMLCanvasElement | null
  const pre = document.getElementById('payload')
  const text = payload()
  if (pre) pre.textContent = text
  if (canvas) void QRCode.toCanvas(canvas, text, { width: 260, margin: 1 })

  document.getElementById('m-rtc')?.classList.toggle('active', mode === 'rtc')
  document.getElementById('m-bc')?.classList.toggle('active', mode === 'broadcast')
}

function switchMode(next: Mode): void {
  if (next === mode) return
  mode = next
  void start()
  render()
  log(`切换到「${next}」模式`)
}

document.getElementById('regen')?.addEventListener('click', () => {
  ticket = randomTicket()
  render()
  log(`二维码已重新生成（新 ticket=${ticket}）`)
})

document.getElementById('copy')?.addEventListener('click', () => {
  void navigator.clipboard?.writeText(payload()).then(
    () => log('配对串已复制'),
    () => log('复制失败：请手动选中上方文本'),
  )
})

document.getElementById('m-rtc')?.addEventListener('click', () => switchMode('rtc'))
document.getElementById('m-bc')?.addEventListener('click', () => switchMode('broadcast'))

document.getElementById('it-low')?.addEventListener('click', () =>
  fireInteraction({
    kind: 'authorization',
    tier: 'low',
    permName: 'terminal.normal.execute',
    title: '执行命令',
    desc: 'git status',
    risk: 'safe',
  }),
)
document.getElementById('it-high')?.addEventListener('click', () =>
  fireInteraction({
    kind: 'authorization',
    tier: 'high',
    permName: 'sandbox.command.execute',
    title: '执行命令（不使用沙盒）',
    subTitle: '需要管道 stdio 的工具（vitest / vite 等）',
    desc: 'pnpm vitest run',
    risk: 'safe',
    sandboxBypass: true,
  }),
)
document.getElementById('it-choice')?.addEventListener('click', () =>
  fireInteraction({
    kind: 'choice',
    question: '要用哪个包管理器装依赖？',
    options: ['pnpm', 'npm', 'yarn'],
    multi: false,
  }),
)
document.getElementById('it-term')?.addEventListener('click', () =>
  fireInteraction({
    kind: 'authorization',
    tier: 'high',
    presentation: 'terminal',
    permName: 'terminal.install.execute',
    title: '执行命令（终端内确认）',
    desc: 'npm i -g pnpm',
    risk: 'install',
  }),
)

function fireInteraction(spec: Parameters<MockHostDataSource['triggerInteraction']>[0]): void {
  const src = hostSource
  if (!src) {
    log('宿主未就绪，无法发起交互')
  } else {
    const id = src.triggerInteraction(spec)
    log(`已发起交互 ${id}（tier=${spec?.tier ?? 'low'}）→ 请在手机上应答`)
  }
}

function randomTicket(): string {
  return Math.random().toString(36).slice(2, 10)
}

// 上下文占用：直接改 mock 的用量并推事件（手机端应实时更新百分比）
document.getElementById('ctx-low')?.addEventListener('click', () => {
  hostSource?.bumpContext('demo-1', 20_000)
  log('上下文占用 → 10%（20k / 200k）')
})
document.getElementById('ctx-high')?.addEventListener('click', () => {
  hostSource?.bumpContext('demo-1', 150_000)
  log('上下文占用 → 75%（150k / 200k）→ 手机端可出现「压缩上下文」')
})

void start()
render()
log('宿主已启动，等待手机/对端连接…')
