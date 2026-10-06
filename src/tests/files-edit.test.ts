/**
 * 编辑保存（§37 **覆写**）的手机端回归 —— 真实内存链路 + mock 宿主，一个 RPC 都不 mock。
 *
 * 这一层的缺陷全都不抛异常，只在真机上表现为「看起来保存了」：
 *
 * - 保存后**电脑上那份文件的字节到底变了没有**（只能从宿主侧看 —— 手机端的应答只说「成功了」）；
 * - CRLF 文件被编辑一次就整篇翻成 LF（diff 满屏红，评审时看不出改了什么）；
 * - 电脑上（AI 正在写）的改动被手机静默吞掉；
 * - 手机上刚敲的字在误触「取消」后就没了。
 *
 * 所以这里的断言全部落在**宿主的文件树**与**真实 DOM**上，而不是「store 里某个字段变成了什么」。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
  createMemoryPair,
  registerHostHandlers,
  type HostRegistration,
  type MemoryTransport,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource } from 'virlen-remote/testing'
import FileSheet from '../ui/components/FileSheet'
import { chatStore } from '../store/chat'
import { connectionStore } from '../store/connection'
import { fileStore } from '../store/files'
import { linkStore } from '../store/link'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSION_ID = 'demo-1'
const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

let host: {
  hostT: MemoryTransport
  mobileT: MemoryTransport
  ep: Endpoint
  reg: HostRegistration
  mock: MockHostDataSource
} | null = null
let container: HTMLDivElement | null = null
let root: Root | null = null
let closed = 0

async function connect(helloOverride?: Partial<MockHostDataSource>): Promise<void> {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 3000 })
  const mock = createMockHostDataSource()
  const reg = registerHostHandlers(ep, helloOverride ? { ...mock, ...helloOverride } : mock, {
    deviceName: 'Virlen 电脑（演示）',
  })
  mock.bind(reg.emit)
  host = { hostT, mobileT, ep, reg, mock }
  await connectionStore.connect({
    hostId: 'demo-host',
    deviceName: '演示电脑',
    token: 'demo-token',
    transport: mobileT,
  })
}

function render(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(FileSheet, { sessionId: SESSION_ID, onClose: () => (closed += 1) }))
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

const textarea = (): HTMLTextAreaElement => {
  const el = container?.querySelector<HTMLTextAreaElement>('.files__editor-text')
  if (!el) throw new Error('编辑区没出现')
  return el
}

/**
 * 往受控 textarea 里打字。
 *
 * 必须走原型上的 setter：React 在节点上装了 value 追踪器，直接给 `node.value` 赋值会被它判成
 * 「值没变」而丢掉这次 onChange（testing-library 内部也是这么做的）。
 */
function type(value: string): void {
  const el = textarea()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 打开面板 → 进 `src` → 点开某个文件 → （可选）进编辑区。 */
async function openFile(name: string, dir = 'src', edit = true): Promise<void> {
  render()
  await waitFor(() => fileStore.getSnapshot().entries.length > 0)
  await flush()
  if (dir) {
    click(byText('.files__row', dir))
    await waitFor(() => fileStore.getSnapshot().relPath === dir)
    await flush()
  }
  click(byText('.files__row', name))
  await waitFor(() => fileStore.getSnapshot().preview != null)
  await flush()
  if (edit) {
    click(byText('button', '编辑'))
    await waitFor(() => fileStore.getSnapshot().editor != null)
  }
}

const hostText = (relPath: string): string =>
  new TextDecoder().decode(host!.mock.readMockFile(SESSION_ID, relPath) ?? new Uint8Array(0))

beforeEach(() => {
  closed = 0
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:test'),
    revokeObjectURL: vi.fn(),
  }))
})

afterEach(async () => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
  fileStore.close()
  chatStore.reset()
  connectionStore.disconnect()
  linkStore.detach()
  host?.reg.dispose()
  host?.ep.dispose()
  host?.hostT.close()
  host?.mobileT.close()
  host = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await flush(0)
})

describe('文件编辑（覆写保存）', () => {
  it('只给可编辑的文件入口：代码文件有「编辑」，二进制没有', async () => {
    await connect()
    await openFile('index.ts', 'src', false)
    expect(byText('button', '编辑')).toBeTruthy()

    // 二进制（`build/app.bin`）：连预览都没有，自然也没有编辑
    click(container!.querySelector('.files__back')!)
    await waitFor(() => fileStore.getSnapshot().preview == null)
    click(byText('.files__crumb', 'virlen-demo'))
    await waitFor(() => fileStore.getSnapshot().relPath === '')
    click(byText('.files__row', 'build'))
    await waitFor(() => fileStore.getSnapshot().relPath === 'build')
    await flush()
    click(byText('.files__row', 'app.bin'))
    await waitFor(() => fileStore.getSnapshot().preview != null)
    await flush()
    expect(container!.querySelector('.files__edit')).toBeNull()
    expect(container!.textContent).toContain('不能在手机上预览')
  })

  it('改内容 → 保存：**电脑上那份文件的字节真的变了**，预览跟着变，并退出编辑区', async () => {
    await connect()
    await openFile('index.ts')
    // 编辑区里是原文（LF 化）
    expect(textarea().value).toContain("import { createApp } from '@/app'")

    type("import { createApp } from '@/app'\n\nconsole.log('edited on phone')\n")
    expect(container!.textContent).toContain('有未保存的改动')

    click(byText('.files__actions button', '保存'))
    await waitFor(() => fileStore.getSnapshot().editor == null)
    await flush()

    // 落盘的是编辑后的字节（含结尾换行），并且是**同一个路径**（不是 - 副本）
    expect(hostText('src/index.ts')).toBe("import { createApp } from '@/app'\n\nconsole.log('edited on phone')\n")
    expect(host!.mock.listMockFiles(SESSION_ID).some((p) => p.includes('副本'))).toBe(false)
    // 预览换成刚写上去的内容 + 一句提示；编辑区退出
    expect(container!.querySelector('.files__text')?.textContent).toContain('edited on phone')
    expect(container!.textContent).toContain('已保存')
    expect(container!.querySelector('.files__editor-text')).toBeNull()
  })

  it('CRLF 原文件：编辑保存后**行尾仍是 CRLF**（只改内容、不整篇改写行尾）', async () => {
    await connect()
    // 造一个 Windows 风格的文件（手机 textarea 只有 LF，最容易在这里把整篇翻成 LF）
    host!.mock.writeMockFile(SESSION_ID, 'src/run.bat', '@echo off\r\necho hi\r\n')
    await openFile('run.bat')

    type('@echo off\necho hi from phone\n')
    click(byText('.files__actions button', '保存'))
    await waitFor(() => fileStore.getSnapshot().editor == null)
    await flush()

    const saved = hostText('src/run.bat')
    expect(saved).toBe('@echo off\r\necho hi from phone\r\n')
    expect(saved).toContain('\r\n')
  })

  it('未改动的「取消」：一个字节都不发（不产生任何 RPC）', async () => {
    await connect()
    await openFile('index.ts')
    const before = host!.mock.calls.length
    click(byText('.files__actions button', '取消'))
    await waitFor(() => fileStore.getSnapshot().editor == null)
    expect(host!.mock.calls.length).toBe(before)
    // 原文件一动没动
    expect(hostText('src/index.ts')).toContain("import { createApp } from '@/app'")
  })

  it('有未保存改动时的「取消」：先确认；点「否」留在编辑区、文件没变', async () => {
    await connect()
    await openFile('index.ts')
    type('我把原文删了')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    click(byText('.files__actions button', '取消'))
    expect(confirm).toHaveBeenCalled()
    expect(fileStore.getSnapshot().editor).not.toBeNull()
    expect(textarea().value).toBe('我把原文删了')
    // 电脑侧那份文件从头到尾没被动过（草稿只在手机上）
    expect(hostText('src/index.ts')).toContain("import { createApp } from '@/app'")
  })

  it('冲突：期间电脑侧改了它 → 保存被拒；草稿留着，给「重新载入 / 强制覆盖」两个选择', async () => {
    await connect()
    await openFile('index.ts')
    type('手机上改的\n')
    // 模拟「AI 正在写这个文件」
    host!.mock.writeMockFile(SESSION_ID, 'src/index.ts', 'AI 刚写的\n')

    click(byText('.files__actions button', '保存'))
    await waitFor(() => container!.querySelector('.files__conflict') != null)
    expect(container!.textContent).toContain('已经变了')
    // 草稿还在（用户刚敲的字不能因为一次冲突就没了）
    expect(textarea().value).toBe('手机上改的\n')
    // 电脑上那一版**没有被覆盖**
    expect(hostText('src/index.ts')).toBe('AI 刚写的\n')

    // 选「强制覆盖」：先取一次当前版本再写，于是写成功
    click(byText('.files__conflict-actions button', '强制覆盖'))
    await waitFor(() => fileStore.getSnapshot().editor == null)
    await flush()
    expect(hostText('src/index.ts')).toBe('手机上改的\n')
  })

  it('冲突后选「重新载入」：草稿换成电脑上的新版本，且不再报冲突', async () => {
    await connect()
    await openFile('index.ts')
    type('手机上改的\n')
    host!.mock.writeMockFile(SESSION_ID, 'src/index.ts', 'AI 刚写的\n')
    click(byText('.files__actions button', '保存'))
    await waitFor(() => container!.querySelector('.files__conflict') != null)

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    click(byText('.files__conflict-actions button', '重新载入'))
    await waitFor(() => textarea().value === 'AI 刚写的\n')
    expect(container!.querySelector('.files__conflict')).toBeNull()
    // 载入之后立刻保存应当成功（版本凭据已经换成新的那一版）
    click(byText('.files__actions button', '保存'))
    await waitFor(() => fileStore.getSnapshot().editor == null)
    expect(hostText('src/index.ts')).toBe('AI 刚写的\n')
  })

  it('连续保存两次不会误判冲突（回执里的新版本被记下来了）', async () => {
    await connect()
    await openFile('index.ts')
    type('第一次\n')
    click(byText('.files__actions button', '保存'))
    await waitFor(() => fileStore.getSnapshot().editor == null)
    await flush()

    click(byText('button', '编辑'))
    await waitFor(() => fileStore.getSnapshot().editor != null)
    type('第二次\n')
    click(byText('.files__actions button', '保存'))
    await waitFor(() => fileStore.getSnapshot().editor == null)
    expect(hostText('src/index.ts')).toBe('第二次\n')
  })

  it('非 UTF-8（GBK）文件：不给编辑，并说明为什么', async () => {
    await connect()
    // 「中文」的 GBK 字节：在电脑上看得好好的，宽容解码后存回去就是毁文件
    host!.mock.writeMockFile(SESSION_ID, 'docs/gbk.txt', new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]))
    await openFile('gbk.txt', 'docs', false)

    expect(container!.querySelector('.files__edit')).toBeNull()
    expect(container!.textContent).toContain('UTF-8')
  })

  it('超过编辑上限（256KB）的文本：能看、不能改，并说明为什么', async () => {
    await connect()
    host!.mock.writeMockFile(SESSION_ID, 'docs/big.log', 'x'.repeat(300 * 1024))
    await openFile('big.log', 'docs', false)

    expect(container!.querySelector('.files__edit')).toBeNull()
    expect(container!.textContent).toContain('编辑上限')
  })

  it('旧电脑端（没有 file.edit）：预览照旧，但没有「编辑」入口', async () => {
    // 旧电脑端会静默忽略 `overwrite`（一次覆盖会退化成「另存为 - 副本」），所以入口直接不出现
    await connect({
      hello: async (params) => {
        const result = await createMockHostDataSource().hello!(params)
        return { ...result, capabilities: result.capabilities.filter((cap) => cap !== 'file.edit') }
      },
    })
    await openFile('index.ts', 'src', false)
    expect(container!.querySelector('.files__text')?.textContent).toContain('createApp')
    expect(container!.querySelector('.files__edit')).toBeNull()
  })
})
