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
/**
 * 模拟链路通讯类型（§37 的非中继门槛）—— `?files=relay` 让所有文件 RPC 一律拒。
 *
 * 为何不做一个「切链路类型」的按钮：换数据源会连带丢掉演示文件树与会话订阅状态，
 * 而那个状态在联调过程中是有价值的（传到一半的进度、刚上传的文件）。用 URL 参数开口，
 * 刷新一次页面就到手 —— 想要的状态从头开始。（真实的中继判定在 `LinkKindWatcher`，
 * 这里只是让模拟宿主按同一句口径拒。）
 */
const FILE_LINK: 'direct' | 'relay' = params.get('files') === 'relay' ? 'relay' : 'direct'

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
      「占用 75%」后手机端会话信息面板才会出现压缩按钮（与桌面 token 环同判据：低于 40% 不给压）。
      面板里是**两个**入口：「AI 摘要压缩」与「正文压缩」—— 演示宿主按 <code>mode</code> 出不同产物
      （后者那句会写「正文压缩」），选了哪种一看摘要气泡就知道。
      压缩后 mock 会把消息换成一条摘要 + 推 messages.reset，手机端应自动重拉。
      摘要气泡**默认折叠**（只留标签 + 开头），点一下展开全文、再点收回。
    </p>
    <div class="row">
      <button id="ctx-low" type="button">占用 10%</button>
      <button id="ctx-high" type="button">占用 75%</button>
    </div>
    <h2>工具的两个阶段（验证手机端尾部）</h2>
    <p class="muted">
      「参数累积中」→ 手机尾部应显示「正在生成工具调用 write_file · 1.2k 字符…」；
      「开始执行」→ 应换成「正在执行 write_file · src/store/chat.ts」这样的行（工具名 + 入参摘要）；
      「执行完毕」→ 那些行消失。两者是**先后相接**的两段：参数生成完、工具开跑那一刻就换口味。
    </p>
    <div class="row">
      <button id="tool-args" type="button">参数累积中</button>
      <button id="tool-run" type="button">开始执行</button>
      <button id="tool-done" type="button">执行完毕</button>
    </div>
    <h2>工作目录文件（§37）</h2>
    <p class="muted">
      手机端入口在会话信息面板的「工作目录」那一行：<b>浏览文件</b>（顶栏已收敛到三个图标，
      不再放文件图标）。
      演示目录里真的有一棵树（<code>src/</code>、<code>docs/</code>）、一张真 PNG 可预览、
      <code>build/app.bin</code> 是未知类型（只能下载）；上传落到同一棵树上，用
      「同名再传一次」可看到电脑侧自动改名「- 副本」。
    </p>
    <p class="muted">
      打开一个<b>文本 / 代码</b>文件后，预览头部有 <b>编辑</b>：改完保存是<b>原地覆写</b>
      （同路径、不产生「- 副本」），回执会带新的版本号。演示宿主也真的按三条纪律拒：
      目标必须存在、只收可编辑扩展名、编辑上限 256KB。
      想手工验「冲突」那条路：在手机上进编辑区 → 在电脑上用别的编辑器改同一个文件（或在本页
      的连接里用别的客户端写它）→ 回到手机上点保存，应当看到「已经变了」+ 重新载入 / 强制覆盖。
    </p>
    <p class="muted">
      预览头部还有一个 <b>引用</b>：把这份文件挂到<b>待发的那条消息</b>上（只带路径，不搬运内容 ——
      内容由 AI 用 <code>read_file</code> 按需读）。点一下变「已引用」，再点一下取消；
      <b>面板不会自动关</b>（可以接着引用下一个），关掉面板后能在输入区看到 chip。
      验收点：发出去之后，电脑端那条用户消息的正文里<b>不会</b>出现 <code>[文件] …</code>，
      且桌面气泡上会显示一个真正的文件 chip（参数走结构化 <code>files</code>，不是拼出来的文本）。
      想验降级：把本页 hello 应答里的 <code>message.file</code> 去掉 → 手机端的「引用」按钮应当
      直接不出现（而不是点了没反应 —— 旧电脑端会把 <code>files</code> 静默丢掉）。
    </p>
    <div class="row">
      <span class="muted">非中继门槛：以 <code>?files=relay</code> 打开本页 → 所有文件操作一律拒（手机端应整面板显示同一句理由）</span>
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

/**
 * 把 `host.hello` 里手机自报的身份摘成一行 —— 联调「名字不对」时第一眼要看的就是它。
 *
 * 为什么值得单独打：电脑端「已绑定手机」列表 / 配对确认框里显示的**就是这个 `mobileName`**。
 * 一旦那里显示的不是这支手机的名字，靠这行日志能立刻分清责任：
 * - 这里打出来的是 `Pixel 7 · 1a2b` → 手机报对了，问题在电脑端怎么显示 / 怎么存；
 * - 这里打出来的是别的东西（或空）→ 手机端报错了，查 `lib/identity.ts`。
 */
function describeHello(params: unknown): string {
  const p = params as
    | { mobileName?: unknown; mobileKey?: unknown; client?: { platform?: unknown } }
    | undefined
  const name = typeof p?.mobileName === 'string' && p.mobileName ? p.mobileName : '(未报名字)'
  const key = typeof p?.mobileKey === 'string' && p.mobileKey ? p.mobileKey : '(未报 key)'
  const platform = typeof p?.client?.platform === 'string' ? p.client.platform : '?'
  return `${name} · ${key} · ${platform}`
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
  //（验证手机端的工具调用卡片「list_files · 3 行」与「空气泡不渲染」两条规则）
  const source = createMockHostDataSource({
    streamSteps: 3,
    streamDelayMs: 60,
    demoToolMessage: true,
    // §37：模拟链路类型（`?files=relay` = 手机端应当被拒并说明原因）
    fileLinkKind: FILE_LINK,
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
      log(method === 'host.hello' ? `← 调用 host.hello（手机自称：${describeHello(params)}）` : `← 调用 ${method}`)
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

/*
 * 工具的两个阶段（§27 与它的姊妹字段）——手推给手机，验证尾部那几行。
 *
 * ⚠️ 真实电脑侧没有这两个「手动口」：参数累积进度由引擎的 `tool_progress` 事件驱动，
 * 「正在执行」由 `store-bridge` 从会话消息推导（assistant 的 `toolCalls[]` 减去已有结果）。
 * 这里只是让**没有引擎**的演示宿主能把这两帧发出来。
 */
document.getElementById('tool-args')?.addEventListener('click', () => {
  hostSource?.setToolProgress('demo-1', { name: 'write_file', chars: 1200 })
  log('参数累积中：write_file · 1200 字符')
})
document.getElementById('tool-run')?.addEventListener('click', () => {
  hostSource?.setRunningTools('demo-1', [
    { toolCallId: 'tc-demo-1', name: 'write_file', args: 'src/store/chat.ts · 写入 42 行' },
    { toolCallId: 'tc-demo-2', name: 'execute_command', args: 'pnpm vitest run' },
  ])
  log('工具开始执行：write_file / execute_command')
})
document.getElementById('tool-done')?.addEventListener('click', () => {
  hostSource?.setRunningTools('demo-1', null)
  log('工具执行完毕（尾部那几行应消失、会话回到空闲）')
})

void start()
render()
log('宿主已启动，等待手机/对端连接…')
