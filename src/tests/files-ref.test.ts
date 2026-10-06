/**
 * 「把电脑上的文件引用到对话」（§37）的手机端回归 —— 真实内存链路 + mock 宿主，一个 RPC 都不 mock。
 *
 * 这一层的缺陷全都不抛异常，只在真机上表现为「看起来附上了」：
 *
 * - 手机端的 chip 还在，而电脑侧**根本没收到**（旧电脑端会静默丢掉 `files`）——
 *   所以既钉「请求真的带上了」，也钉「电脑端不认时入口压根不出现」；
 * - 发完不清 chip（下一条消息会莫名其妙又附上同一个文件）；
 * - 只附文件不写正文发不出去（用户以为「引用坏了」）；
 * - 只带文件的消息在列表里被当成「渲染不出东西」丢掉（用户看不到自己发的那条）。
 *
 * 断言尽量落在**宿主侧的消息**与**真实 DOM**上，而不是「store 里某个字段变成了什么」。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
  MESSAGE_FILE_CAPABILITY,
  createMemoryPair,
  registerHostHandlers,
  type HelloParams,
  type HostRegistration,
  type MemoryTransport,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource } from 'virlen-remote/testing'
import Chat from '../ui/pages/Chat'
import { chatStore } from '../store/chat'
import { connectionStore } from '../store/connection'
import { devicesStore } from '../store/devices'
import { fileStore } from '../store/files'
import { linkStore } from '../store/link'
import { toFileRef } from '../lib/files'
import { buildRows, rendersNothing } from '../lib/message-rows'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION_ID = 'demo-1'
/** mock 宿主里 `demo-1` 的工作目录（`DEMO_WORKSPACES[0]`）。 */
const WORKSPACE = 'E:/code/virlen-demo'
const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 轮询直到条件成立（内存传输的事件投递是异步的）。
 *
 * ⚠️ 整段包在 `act` 里：等待期间到达的事件会改 React 状态（`message.added` 等），
 * 不包的话每一条都吐一行 act 警告 —— 真正的失败信息会被淹得看不见。
 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  await act(async () => {
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
      await flush(5)
    }
  })
}

interface HostHarness {
  hostT: MemoryTransport
  mobileT: MemoryTransport
  ep: Endpoint
  reg: HostRegistration
  mock: MockHostDataSource
}

let host: HostHarness | null = null
let container: HTMLDivElement | null = null
let root: Root | null = null

/**
 * 连上演示宿主。
 *
 * `withoutFileCapability` 模拟**旧电脑端**：它在 `hello` 里没有 `message.file`
 * （会静默丢掉 `files`）—— 手机端因此不该给出「引用」入口。
 */
async function connect(options: { withoutFileCapability?: boolean } = {}): Promise<void> {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 3000 })
  const base = createMockHostDataSource()
  const source: MockHostDataSource = options.withoutFileCapability
    ? {
        ...base,
        hello: async (params: HelloParams) => {
          const hello = await base.hello!(params)
          return {
            ...hello,
            capabilities: hello.capabilities.filter((c) => c !== MESSAGE_FILE_CAPABILITY),
          }
        },
      }
    : base
  const reg = registerHostHandlers(ep, source, { deviceName: 'Virlen 电脑（演示）' })
  base.bind(reg.emit)
  host = { hostT, mobileT, ep, reg, mock: base }
  await connectionStore.connect({
    hostId: 'demo-host',
    deviceName: '演示电脑',
    token: 'demo-token',
    transport: mobileT,
  })
  await chatStore.openSession(SESSION_ID)
}

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(Chat))
  })
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function byText(selector: string, text: string): HTMLElement {
  const found = [...(container?.querySelectorAll(selector) ?? [])].find((el) =>
    el.textContent?.includes(text),
  )
  if (!found) throw new Error(`没找到 ${selector}（含「${text}」）`)
  return found as HTMLElement
}

/** 输入框打字：React 受控组件必须走原型上的 setter，直接改 value 不会触发 onChange。 */
function typeInto(value: string): void {
  const el = container!.querySelector<HTMLTextAreaElement>('.chat__textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(el, value)
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 走一遍真实入口进文件面板：会话信息面板 → 「浏览文件」（顶栏没有文件入口，见 `Chat.tsx` 文件头）。 */
async function openFilePanel(): Promise<void> {
  click(container!.querySelector('.chat__head-main')!)
  await waitFor(() => !!byText('button', '浏览文件'))
  click(byText('button', '浏览文件'))
  await waitFor(() => fileStore.getSnapshot().entries.length > 0)
  await flush()
}

/** 面板里进 `src` 并点开 `index.ts`（走条目行的真实点击）。 */
async function openPreview(): Promise<void> {
  click(byText('.files__row', 'src'))
  await waitFor(() => fileStore.getSnapshot().relPath === 'src')
  await flush()
  click(byText('.files__row', 'index.ts'))
  await waitFor(() => fileStore.getSnapshot().preview != null)
  await flush()
}

/** 宿主侧最后一条用户消息（手机发出的那条）。 */
async function lastUserMessage() {
  const list = await host!.mock.getMessages({ sessionId: SESSION_ID })
  const mine = list.messages.filter((m) => m.role === 'user')
  return mine[mine.length - 1]!
}

const chipNames = (): string[] =>
  [...(container?.querySelectorAll('.chat__files .file-chip__name') ?? [])].map(
    (el) => el.textContent ?? '',
  )

beforeEach(() => {
  chatStore.reset()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
})

afterEach(async () => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
  fileStore.close()
  connectionStore.disconnect()
  linkStore.detach()
  if (host) {
    host.reg.dispose()
    host.ep.dispose()
    host.hostT.close()
    host.mobileT.close()
    host = null
  }
  vi.restoreAllMocks()
  await flush(0)
})

/* ───────────────────────── 纯函数：引用体的构造与行模型 ───────────────────────── */

describe('toFileRef —— 拼路径的口径', () => {
  it('反斜杠与尾斜杠都归一化（否则「已引用」的比对与回显会对不上）', () => {
    expect(toFileRef('E:\\code\\proj\\', 'index.ts', { size: 12 })).toEqual({
      path: 'E:/code/proj/index.ts',
      name: 'index.ts',
      size: 12,
    })
  })

  it('目录带 `isDir` 且**不带体积**（「目录 12 KB」是一句假话）', () => {
    expect(toFileRef('E:/code/proj', 'src', { isDir: true, size: 999 })).toEqual({
      path: 'E:/code/proj/src',
      name: 'src',
      isDir: true,
    })
  })

  it('拿不到工作目录时不拼出一个前导斜杠', () => {
    expect(toFileRef('', 'a.ts').path).toBe('a.ts')
  })
})

describe('行模型 —— 只附文件的消息不能被当成「渲染不出东西」', () => {
  it('无正文但有文件引用 → 占一行（用户要看得见自己发的那条）', () => {
    expect(rendersNothing({ role: 'user', text: '', files: [{ path: 'E:/a', name: 'a' }] })).toBe(
      false,
    )
    // 既没正文也没附件才是真空消息（纯工具调用轮的 assistant 就是它）
    expect(rendersNothing({ role: 'user', text: '' })).toBe(true)
  })

  it('`buildRows` 里它是一条独立的行', () => {
    const rows = buildRows([
      { id: 'u1', role: 'user', text: '', createdAt: 0, files: [{ path: 'E:/a', name: 'a' }] },
    ])
    expect(rows.map((r) => r.key)).toEqual(['u1'])
  })
})

/* ───────────────────────── 整条链路：面板 → chip → 电脑侧收到 ───────────────────────── */

describe('文件引用：从文件面板到电脑侧', () => {
  it('「引用」→ chip 出现 → 发送：电脑侧真的收到了 `files`，且发完 chip 清空', async () => {
    await connect()
    mount()
    await openFilePanel()
    await openPreview()

    click(container!.querySelector('.files__ref')!)
    expect(byText('.files__ref', '已引用')).toBeTruthy()

    // 面板不自动关（用户还能接着引用下一个）：关掉之后 chip 才看得见
    click(container!.querySelector('.sheet__close')!)
    await waitFor(() => container!.querySelector('.files__ref') == null)
    await waitFor(() => chipNames().length === 1)
    expect(chipNames()).toEqual(['index.ts'])
    // chip 上带完整路径（放不下，但要能对认）
    expect(container!.querySelector('.file-chip__name')!.getAttribute('title')).toBe(
      `${WORKSPACE}/src/index.ts`,
    )

    // 只附文件、不写正文也允许发（与桌面同口径：电脑侧会补一句兜底正文）
    const send = byText('button', '发送') as HTMLButtonElement
    expect(send.disabled).toBe(false)
    click(send)

    await waitFor(() => chipNames().length === 0)
    const sent = await lastUserMessage()
    expect(sent.files).toEqual([
      {
        path: `${WORKSPACE}/src/index.ts`,
        name: 'index.ts',
        size: host!.mock.readMockFile(SESSION_ID, 'src/index.ts')!.length,
      },
    ])
    // 手机端不写正文时，电脑侧补的那一句（与桌面 `buildUserContent` 同义）
    expect(sent.text).toBe('看看这些文件')
  })

  it('「已引用」再点一下 = 取消引用（面板里就能撤，不必先关面板再找 chip）', async () => {
    await connect()
    mount()
    await openFilePanel()
    await openPreview()

    click(container!.querySelector('.files__ref')!)
    await waitFor(() => byText('.files__ref', '已引用') != null)
    click(container!.querySelector('.files__ref')!)
    expect(byText('.files__ref', '引用')).toBeTruthy()

    click(container!.querySelector('.sheet__close')!)
    await flush()
    expect(chipNames()).toEqual([])
  })

  it('输入区的 chip 可以单独删掉（与引用 chip 同一种操作）', async () => {
    await connect()
    mount()
    await openFilePanel()
    await openPreview()
    click(container!.querySelector('.files__ref')!)
    click(container!.querySelector('.sheet__close')!)
    await waitFor(() => chipNames().length === 1)

    click(container!.querySelector('.file-chip__remove')!)
    expect(chipNames()).toEqual([])
  })

  it('同一个文件连点两下只算一个（不然会附两遍）', async () => {
    await connect()
    mount()
    await openFilePanel()
    await openPreview()

    click(container!.querySelector('.files__ref')!) // 引用
    click(container!.querySelector('.files__ref')!) // 取消
    click(container!.querySelector('.files__ref')!) // 再引用
    click(container!.querySelector('.sheet__close')!)
    await waitFor(() => chipNames().length === 1)
    expect(chipNames()).toEqual(['index.ts'])
  })

  it('带正文时正文原样发出（chip 与正文一起走）', async () => {
    await connect()
    mount()
    await openFilePanel()
    await openPreview()
    click(container!.querySelector('.files__ref')!)
    click(container!.querySelector('.sheet__close')!)
    await waitFor(() => chipNames().length === 1)

    typeInto('帮我看看这个文件')
    click(byText('button', '发送'))
    await waitFor(() => chipNames().length === 0)
    const sent = await lastUserMessage()
    expect(sent.text).toBe('帮我看看这个文件')
    expect(sent.files).toHaveLength(1)
  })

  it('没有引用文件时**不带** `files` 字段（不为旧电脑端凭空多一个空数组）', async () => {
    await connect()
    mount()
    typeInto('普通一条')
    click(byText('button', '发送'))
    await waitFor(() => (chatStore.getSnapshot().messages[SESSION_ID] ?? []).some((m) => m.role === 'user'))
    const sent = await lastUserMessage()
    expect('files' in sent).toBe(false)
  })

  it('气泡上回显文件 chip（电脑侧下行 `MessageDTO.files`）', async () => {
    await connect()
    mount()
    await openFilePanel()
    await openPreview()
    click(container!.querySelector('.files__ref')!)
    click(container!.querySelector('.sheet__close')!)
    await waitFor(() => chipNames().length === 1)
    click(byText('button', '发送'))

    // 消息经事件回推后，气泡里出现同一个附件（读的顺序：正文 → 附件）
    await waitFor(() => !!container!.querySelector('.msg--user .msg__files .file-chip'))
    const bar = container!.querySelector('.msg--user .msg__files .file-chip__name')!
    expect(bar.textContent).toBe('index.ts')
    // 手机端只用来对认，不是入口（那是电脑上的文件）
    expect(bar.getAttribute('title')).toBe(`${WORKSPACE}/src/index.ts`)
  })

  it('旧电脑端（未声明 `message.file`）→ 整个「引用」入口不出现，浏览照旧能用', async () => {
    await connect({ withoutFileCapability: true })
    mount()
    await openFilePanel()
    await openPreview()

    // 面板本身还能用（浏览 / 预览 / 下载 / 编辑都还在），只是没有「引用」
    expect(fileStore.canReference()).toBe(false)
    expect(container!.querySelector('.files__ref')).toBeNull()
    expect(container!.querySelector('.files__download, .files__actions')).toBeTruthy()
  })
})
