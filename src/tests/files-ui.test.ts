/**
 * 文件面板的界面接线（§37）—— 冒烟级用例，盯的全是「手指点下去会不会到」。
 *
 * 这一层的缺陷不抛异常：图标点了没反应、目录点进去面包屑没动、中继时按钮还能点。
 * 纯逻辑口径已在 `files-lib.test.ts` / `files-store.test.ts` 钉死，这里只确认 DOM 里
 * **看得到、点得动、点了到对地方**。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
  FILE_DIRECT_ONLY_MESSAGE,
  createMemoryPair,
  registerHostHandlers,
  type HostRegistration,
  type MemoryTransport,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource } from 'virlen-remote/testing'
import Chat from '../ui/pages/Chat'
import FileSheet from '../ui/components/FileSheet'
import { chatStore } from '../store/chat'
import { connectionStore } from '../store/connection'
import { fileStore } from '../store/files'
import { linkStore, type RtcPeer } from '../store/link'

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

/** 假 PeerConnection（把 `linkStore.path` 摆成中继）。 */
class FakePeer implements RtcPeer {
  connectionState = 'connected'
  private list: unknown[] = []
  private readonly listeners = new Set<() => void>()
  setStats(next: unknown[]): void {
    this.list = next
  }
  getStats(): Promise<{ forEach(callback: (entry: unknown) => void): void }> {
    return Promise.resolve({ forEach: (cb: (entry: unknown) => void) => this.list.forEach(cb) })
  }
  addEventListener(_type: 'connectionstatechange', listener: () => void): void {
    this.listeners.add(listener)
  }
  removeEventListener(_type: 'connectionstatechange', listener: () => void): void {
    this.listeners.delete(listener)
  }
}

function relayStats(): unknown[] {
  return [
    { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
    { type: 'candidate-pair', id: 'P0', localCandidateId: 'L0', remoteCandidateId: 'R0', state: 'succeeded' },
    { id: 'L0', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' },
    { id: 'R0', type: 'remote-candidate', candidateType: 'relay' },
    { type: 'data-channel', id: 'DC0', bytesReceived: 12 },
  ]
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

async function connect(): Promise<void> {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 3000 })
  const mock = createMockHostDataSource()
  const reg = registerHostHandlers(ep, mock, { deviceName: 'Virlen 电脑（演示）' })
  mock.bind(reg.emit)
  host = { hostT, mobileT, ep, reg, mock }
  await connectionStore.connect({
    hostId: 'demo-host',
    deviceName: '演示电脑',
    token: 'demo-token',
    transport: mobileT,
  })
}

function render(element: ReturnType<typeof createElement>): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(element)
  })
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 按可见文案找元素（面板里的行名都是文案，用文案比下标稳）。 */
function byText(selector: string, text: string): HTMLElement {
  const found = [...(container?.querySelectorAll(selector) ?? [])].find((el) =>
    el.textContent?.includes(text),
  )
  if (!found) throw new Error(`没找到 ${selector}（含「${text}」）`)
  return found as HTMLElement
}

beforeEach(() => {
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
  vi.unstubAllGlobals()
  await flush(0)
})

describe('文件面板（DOM）', () => {
  it('列出工作目录：目录在前、显示体积、能进能退', async () => {
    await connect()
    render(createElement(FileSheet, { sessionId: SESSION_ID, onClose: () => {} }))
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)
    await flush()

    // 面包屑第一段 = 工作目录名（用户认的是这个，不是完整绝对路径）
    expect(container!.textContent).toContain('virlen-demo')
    const rows = [...container!.querySelectorAll('.files__row')].map((el) => el.textContent ?? '')
    expect(rows.some((r) => r.includes('src'))).toBe(true)
    expect(rows.some((r) => r.includes('目录'))).toBe(true)
    // 文本文件的列尾是体积（不是「目录」）
    expect(rows.some((r) => r.includes('README.md') && /B|KB|MB/.test(r))).toBe(true)

    click(byText('.files__row', 'src'))
    await waitFor(() => fileStore.getSnapshot().relPath === 'src')
    await flush()
    expect(container!.textContent).toContain('index.ts')
    // 面包屑多了一段，且当前级不可再点
    expect(byText('.files__crumb.is-current', 'src')).toBeTruthy()

    click(byText('.files__crumb', 'virlen-demo'))
    await waitFor(() => fileStore.getSnapshot().relPath === '')
  })

  it('点文件行 = 开预览（Markdown 渲染 + 给下载按钮），返回 = 回目录', async () => {
    await connect()
    render(createElement(FileSheet, { sessionId: SESSION_ID, onClose: () => {} }))
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)
    await flush()

    click(byText('.files__row', 'README.md'))
    await waitFor(() => fileStore.getSnapshot().preview != null)
    await flush()

    expect(container!.querySelector('.files__md')).toBeTruthy()
    expect(container!.textContent).toContain('Virlen 演示项目')
    // 预览态才出现「下载」
    expect(byText('button', '下载')).toBeTruthy()

    click(container!.querySelector('.files__back')!)
    await waitFor(() => fileStore.getSnapshot().preview == null)
    expect(container!.textContent).toContain('index.ts'.slice(0, 0) + 'src')
  })

  it('二进制文件：不给预览，只给「请下载」的说明', async () => {
    await connect()
    render(createElement(FileSheet, { sessionId: SESSION_ID, onClose: () => {} }))
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)
    await flush()

    await fileStore.enter('build')
    await waitFor(() => fileStore.getSnapshot().relPath === 'build')
    await flush()

    click(byText('.files__row', 'app.bin'))
    await waitFor(() => fileStore.getSnapshot().preview != null)
    await flush()
    expect(container!.textContent).toContain('不能在手机上预览')
  })

  it('中继链路：整面板换成那句话（与电脑端同一句），上传按钮置灰', async () => {
    await connect()
    const peer = new FakePeer()
    peer.setStats(relayStats())
    linkStore.attach(peer)
    await waitFor(() => linkStore.getSnapshot().path === 'relay')

    render(createElement(FileSheet, { sessionId: SESSION_ID, onClose: () => {} }))
    await flush()

    expect(container!.textContent).toContain(FILE_DIRECT_ONLY_MESSAGE)
    // 没有条目行（不是「列出来了但点不动」）
    expect(container!.querySelectorAll('.files__row')).toHaveLength(0)
    const upload = container!.querySelector('.files__file-input') as HTMLInputElement
    expect(upload.disabled).toBe(true)
  })

  it('电脑端没声明能力：说的是「未开启」，不是链路原因', async () => {
    const [hostT, mobileT] = createMemoryPair()
    const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 3000 })
    const mock = createMockHostDataSource()
    const reg = registerHostHandlers(
      ep,
      {
        ...mock,
        hello: async (params) => ({ ...(await mock.hello!(params)), capabilities: ['session.list'] }),
      },
      { deviceName: '旧版电脑' },
    )
    host = { hostT, mobileT, ep, reg, mock }
    await connectionStore.connect({
      hostId: 'old-host',
      deviceName: '旧版电脑',
      token: 'demo-token',
      transport: mobileT,
    })

    render(createElement(FileSheet, { sessionId: SESSION_ID, onClose: () => {} }))
    await flush()
    expect(container!.textContent).toContain('未开启')
    expect(container!.textContent).not.toContain(FILE_DIRECT_ONLY_MESSAGE)
  })

  it('会话信息面板的「浏览文件」能开文件面板（且不会叠两层）', async () => {
    await connect()
    render(createElement(Chat))
    await chatStore.loadSessions()
    await chatStore.openSession(SESSION_ID)
    await waitFor(() => chatStore.getSnapshot().currentSessionId === SESSION_ID)
    await flush()

    // 顶栏不再有文件夹图标（收敛到三个图标，详见下一条用例）
    expect(container!.querySelector('[aria-label="电脑上的文件"]')).toBeNull()

    // 从会话信息面板进去：信息面板关掉、文件面板打开（两层不叠）
    click(container!.querySelector('.chat__head-main')!)
    await waitFor(() => container!.textContent!.includes('会话信息'))
    click(byText('button', '浏览文件'))
    await waitFor(() => fileStore.getSnapshot().open)
    expect(container!.querySelectorAll('.sheet')).toHaveLength(1)

    // 关掉
    click(container!.querySelector('.sheet__close')!)
    await waitFor(() => !fileStore.getSnapshot().open)
  })

  /**
   * 顶栏图标数量是个**布局预算**，不是口味问题：一个 38px，五个就是 206px，360px 的屏上
   * 左侧标题只剩 ~100px（真机反馈：「五个按钮和左边叠在一起了」）。
   * 这条用例钉住「收敛之后每个功能都仍然到得了」——只减数量、不丢入口。
   */
  it('顶栏只留三个图标；被下沉的「设置」在会话抽屉底栏仍能到达', async () => {
    await connect()
    render(createElement(Chat))
    await chatStore.loadSessions()
    await chatStore.openSession(SESSION_ID)
    await waitFor(() => chatStore.getSnapshot().currentSessionId === SESSION_ID)
    await flush()

    expect(container!.querySelectorAll('.chat__head-actions .iconbtn')).toHaveLength(3)
    expect(container!.querySelector('[aria-label="设置"]')).toBeNull()

    // 设置搬到了会话抽屉底栏（与会话列表同层：都是与当前会话无关的全局动作）
    click(container!.querySelector('[aria-label="会话列表"]')!)
    await waitFor(() => container!.querySelector('.drawer') != null)
    click(byText('.drawer__foot button', '设置'))
    await waitFor(() => container!.querySelector('.sheet__title')?.textContent === '设置')
    // 抽屉先收起再开面板：两个浮层不叠
    expect(container!.querySelector('.drawer')).toBeNull()
    expect(container!.querySelectorAll('.sheet')).toHaveLength(1)
  })

  /**
   * 进目录时**不清空**上一份列表（真机反馈：「loading 时把列表清掉，高度一变就闪一下」）。
   *
   * 这条只能在「在途那一帧」验：把电脑侧的列目录拖慢 40ms，点进去后**不等应答**就地断言。
   * 列表被清空时它缩成一行提示 —— 面板高度是内容撑的，于是先塌再撑，那一下就是闪动。
   */
  it('进目录不清空列表：旧列表留在原地 + 标题栏下转圈，应答回来才整体替换', async () => {
    const [hostT, mobileT] = createMemoryPair()
    const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 3000 })
    const mock = createMockHostDataSource()
    // 拖慢列目录：内存链路会在同一次 `act` 里就答完，抓不到在途那一帧
    const listFiles = mock.listFiles.bind(mock)
    mock.listFiles = async (...args: Parameters<MockHostDataSource['listFiles']>) => {
      await flush(40)
      return listFiles(...args)
    }
    const reg = registerHostHandlers(ep, mock, { deviceName: '慢电脑' })
    mock.bind(reg.emit)
    host = { hostT, mobileT, ep, reg, mock }
    await connectionStore.connect({
      hostId: 'slow-host',
      deviceName: '慢电脑',
      token: 'demo-token',
      transport: mobileT,
    })

    render(createElement(FileSheet, { sessionId: SESSION_ID, onClose: () => {} }))
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)
    await flush()
    const rows = container!.querySelectorAll('.files__row').length
    expect(rows).toBeGreaterThan(0)
    expect(container!.textContent).not.toContain('正在读取目录…')

    click(byText('.files__row', 'src'))

    // 在途那一帧：列表**原样还在**（行数不变），提示是标题栏下那一条
    expect(fileStore.getSnapshot().loading).toBe(true)
    expect(container!.querySelectorAll('.files__row')).toHaveLength(rows)
    expect(container!.textContent).toContain('正在读取目录…')
    // 旧列表是**上一份**目录：在途时点它的条目 = 发错路径
    expect(byText('.files__row', 'README.md').hasAttribute('disabled')).toBe(true)

    await waitFor(() => fileStore.getSnapshot().relPath === 'src')
    await flush()
    expect(container!.textContent).toContain('index.ts')
    expect(container!.textContent).not.toContain('正在读取目录…')
  })
})

/**
 * 布局契约：`jsdom` 不做布局，**「被压扁」「点不到」这类缺陷在 DOM 断言里看不见** ——
 * 元素还在、文案还在、click 也照旧触发，只有真机上它变成了看不见的一条缝。
 * 所以这一组直接读样式表，把它钉住。
 */
describe('文件面板的布局契约', () => {
  /**
   * 真机反馈：「条目一多，面包屑被挤到上面去，只能看到一点点」。
   *
   * 根因：面包屑 `overflow-x: auto`（连带 `overflow-y` 也算 auto）= **滚动容器**，
   * 滚动容器的自动最小高度是 0；而 `.sheet__body` 是 flex 列，内容装不下时先压子项 ——
   * 其它子项 overflow 可见、最小高度等于内容高度压不动，收缩量就全落到它头上。
   * 修法是显式不被压缩；少了这条声明不会报任何错，只会「面包屑不见了」。
   */
  it('面包屑不被长列表压扁：`.files__crumbs` 必须声明 flex-shrink: 0', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/ui/components/FileSheet.css'), 'utf8')
    const block = /\.files__crumbs\s*\{([^}]*)\}/.exec(css)?.[1]
    expect(block, '没找到 .files__crumbs 规则').toBeTruthy()
    expect(
      /flex(-shrink)?\s*:\s*(none|0)\b/.test(block!),
      '.files__crumbs 少了 `flex: none`：列表一长它又会被压成一条缝（见本条注释）',
    ).toBe(true)
  })

  /**
   * 面包屑还要**常驻面板顶部**：列表滚下去时它得在，否则想回上一级只能先把列表滚回顶部。
   *
   * sticky 的代价是**它自己得铺一层不透明背景** —— 否则列表行从它背后滚过时直接「叠字」。
   * 而底色又必须与 `.sheet` **同色**：写死一个颜色，哪天面板换底色，这里就露出一条颜色不同的
   * 带子（两份约定必须一起改，所以这条用例直接把两个值比出来）。
   */
  it('面包屑常驻顶部：sticky + 底色与面板同色（否则列表从它背后透出来）', () => {
    const sheetCss = readFileSync(
      resolve(process.cwd(), 'src/ui/components/SessionInfoSheet.css'),
      'utf8',
    )
    const crumbCss = readFileSync(
      resolve(process.cwd(), 'src/ui/components/FileSheet.css'),
      'utf8',
    )
    // `.sheet` 而非 `.sheet__body`：`{` 紧跟其后，所以不会误配到 BEM 子元素
    const sheetBg = /\.sheet\s*\{([^}]*)\}/
      .exec(sheetCss)?.[1]
      .match(/background:\s*([^;]+);/)?.[1]
      .trim()
    const crumbBlock = /\.files__crumbs\s*\{([^}]*)\}/.exec(crumbCss)?.[1]
    expect(crumbBlock, '没找到 .files__crumbs 规则').toBeTruthy()
    expect(/position\s*:\s*sticky/.test(crumbBlock!)).toBe(true)
    expect(/\btop\s*:\s*0\b/.test(crumbBlock!)).toBe(true)
    expect(crumbBlock!.match(/background:\s*([^;]+);/)?.[1].trim()).toBe(sheetBg)
  })
})
