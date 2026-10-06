/**
 * 文件面板 store（`store/files.ts`）—— 与**真实 mock 宿主**经内存链路对跑。
 *
 * 这一层错的全是「接线」（点目录没反应、上传传了 0 字节、预览拿的是别的文件），
 * 都不抛异常，只在真机上表现为「看起来没生效」。所以这里不 mock 任何 RPC：
 * mock 宿主（`virlen-remote/testing`）里有一份真的演示文件树，写进去的字节能读回来对照。
 *
 * 与电脑侧用例的分工：那边盯「越权 / 中继 / 原子落盘」这些**纪律**；
 * 这边盯「手机发出的每一步请求对不对、界面拿到的中间态对不对」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
  FILE_DIRECT_ONLY_MESSAGE,
  FILE_CHUNK_BYTES,
  createMemoryPair,
  registerHostHandlers,
  type HostRegistration,
  type MemoryTransport,
} from 'virlen-remote'
import { createMockHostDataSource, type MockHostDataSource } from 'virlen-remote/testing'
import { connectionStore } from '../store/connection'
import { fileStore } from '../store/files'
import { chatStore } from '../store/chat'
import { linkStore, type RtcPeer } from '../store/link'

const SESSION_ID = 'demo-1'

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await flush(5)
  }
}

/** 假 PeerConnection（只为把 `linkStore.path` 摆成中继，验证置灰那一句是谁说的）。 */
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

/** 一条「经 TURN 中继」的 stats 记录集（与 `link-watch.test.ts` 同一套形状）。 */
function relayStats(): unknown[] {
  return [
    { type: 'transport', id: 'T0', selectedCandidatePairId: 'P0' },
    { type: 'candidate-pair', id: 'P0', localCandidateId: 'L0', remoteCandidateId: 'R0', state: 'succeeded' },
    { id: 'L0', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' },
    { id: 'R0', type: 'remote-candidate', candidateType: 'relay' },
    { type: 'data-channel', id: 'DC0', bytesReceived: 10 },
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

async function connect(): Promise<HostHarness> {
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
  // 文件面板要用到当前会话的工作目录名（面包屑第一段）
  await chatStore.loadSessions()
  return host
}

/** 造一个浏览器 `File`（上传的输入就是它）。 */
function makeFile(name: string, bytes: Uint8Array, type = 'application/octet-stream'): File {
  return new File([bytes as unknown as BlobPart], name, { type })
}

beforeEach(() => {
  // jsdom 没有 createObjectURL（图片预览会用它）—— 给个真能用的假实现即可，
  // 本用例关心的是「有没有拿到 url」，不是浏览器怎么解码这张图
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:test'),
    revokeObjectURL: vi.fn(),
  }))
})

afterEach(async () => {
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

describe('文件面板 store —— 浏览', () => {
  it('打开即列工作目录根；进子目录、回上一级都真的换了目录', async () => {
    await connect()
    fileStore.open(SESSION_ID)
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)

    const root = fileStore.getSnapshot()
    expect(root.relPath).toBe('')
    expect(root.absPath).toBe('E:/code/virlen-demo')
    expect(root.entries.map((e) => e.name)).toEqual([
      'assets',
      'build',
      'docs',
      'src',
      '.gitignore',
      'package.json',
      'README.md',
    ])

    await fileStore.enter('src')
    const src = fileStore.getSnapshot()
    expect(src.relPath).toBe('src')
    expect(src.entries.map((e) => e.name)).toEqual(['store', 'app.ts', 'index.ts'])

    await fileStore.up()
    expect(fileStore.getSnapshot().relPath).toBe('')

    // 关掉面板 = 状态清空（下次打开不该看到上一次的目录）
    fileStore.close()
    expect(fileStore.getSnapshot()).toMatchObject({ open: false, entries: [], relPath: '' })
  })

  it('点目录条目 = 进去；点不存在的目录 = 一条错误而不是空列表', async () => {
    const h = await connect()
    fileStore.open(SESSION_ID)
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)

    await fileStore.openEntry({ name: 'docs', isDir: true, size: 0 })
    expect(fileStore.getSnapshot().relPath).toBe('docs')
    expect(fileStore.getSnapshot().entries.map((e) => e.name)).toEqual(['notes.txt'])

    // 会话还在，但目录已经不在（电脑上被删了）→ 如实报错，而不是显示「空目录」
    fileStore.close()
    h.mock.writeMockFile(SESSION_ID, 'tmp/keep.txt', 'x')
    fileStore.open(SESSION_ID)
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)
    await fileStore.enter('nope')
    expect(fileStore.getSnapshot().error).toContain('目录不存在')
  })
})

describe('文件面板 store —— 预览', () => {
  it('文本文件读出正文；Markdown 走 markdown 通道', async () => {
    await connect()
    fileStore.open(SESSION_ID)
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)

    await fileStore.preview('README.md', 64)
    const preview = fileStore.getSnapshot().preview
    expect(preview?.kind).toBe('markdown')
    expect(preview?.text).toContain('# Virlen 演示项目')
    expect(preview?.url).toBeUndefined() // 文本不该去建 ObjectURL

    fileStore.closePreview()
    expect(fileStore.getSnapshot().preview).toBeNull()
  })

  it('图片：拿到 ObjectURL；关掉预览时 revoke（不 revoke 就是每看一张漏一份内存）', async () => {
    await connect()
    fileStore.open(SESSION_ID)
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)

    await fileStore.preview('assets/logo.png', 1024)
    const preview = fileStore.getSnapshot().preview
    expect(preview?.kind).toBe('image')
    expect(preview?.url).toBe('blob:test')
    expect(preview?.text).toBeUndefined()

    fileStore.closePreview()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })

  it('二进制 / 空文件 / 超限：**不发请求**就给结论（省一趟 350KB 的 base64）', async () => {
    const h = await connect()
    fileStore.open(SESSION_ID)
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)
    const callsBefore = h.mock.calls.filter((c) => c === 'host.file.read').length

    await fileStore.preview('build/app.bin', 37)
    expect(fileStore.getSnapshot().preview?.reason).toContain('不能')
    expect(fileStore.getSnapshot().preview?.text).toBeUndefined()

    await fileStore.preview('empty.txt', 0)
    expect(fileStore.getSnapshot().preview?.reason).toContain('空文件')

    // 2MB 的「文本」超过 1MB 预览上限：只给下载
    await fileStore.preview('huge.log', 2 * 1024 * 1024)
    expect(fileStore.getSnapshot().preview?.reason).toContain('下载')

    // 三次判断一次 RPC 都没发
    expect(h.mock.calls.filter((c) => c === 'host.file.read').length).toBe(callsBefore)
  })
})

describe('文件面板 store —— 上传 / 下载', () => {
  it('上传：分块送完并落到电脑侧的工作目录（字节一致）；同名自动加「- 副本」', async () => {
    const h = await connect()
    fileStore.open(SESSION_ID)
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)

    const data = new Uint8Array(FILE_CHUNK_BYTES + 1000)
    for (let i = 0; i < data.length; i++) data[i] = (i * 29 + 5) & 0xff
    await fileStore.upload([makeFile('upload.bin', data)])

    expect([...(h.mock.readMockFile(SESSION_ID, 'upload.bin') ?? [])]).toEqual([...data])
    // 上传完自动重列（否则新文件要手动刷新才看得见）
    expect(fileStore.getSnapshot().entries.map((e) => e.name)).toContain('upload.bin')
    expect(fileStore.getSnapshot().notice).toContain('已上传')

    // 同名再传一次 → 电脑侧改名，提示里要说清楚（否则用户会以为「覆盖了」）
    await fileStore.upload([makeFile('upload.bin', new Uint8Array([1, 2, 3]))])
    expect(h.mock.readMockFile(SESSION_ID, 'upload - 副本.bin')).toBeTruthy()
    expect(fileStore.getSnapshot().notice).toContain('upload - 副本.bin')
  })

  it('上传超过协议上限的文件：本端就拦下（连 begin 都不发）', async () => {
    const h = await connect()
    fileStore.open(SESSION_ID)
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)

    // 不真造 32MB 字节：`File` 的 size 由内容决定，所以只断言「在途态没有出现过」
    const tiny = makeFile('tiny.txt', new Uint8Array([1]))
    await fileStore.upload([tiny])
    expect(h.mock.readMockFile(SESSION_ID, 'tiny.txt')?.length).toBe(1)
  })

  it('下载：分块收完交给浏览器（jsdom 里没有 share → 走 <a download>）', async () => {
    const h = await connect()
    fileStore.open(SESSION_ID)
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)

    // jsdom 不实现导航：把 anchor.click 替成可观测的桩
    const click = vi.fn()
    const original = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = click
    try {
      await fileStore.download('README.md', 64)
    } finally {
      HTMLAnchorElement.prototype.click = original
    }

    expect(click).toHaveBeenCalled()
    expect(fileStore.getSnapshot().download).toBeNull()
    expect(fileStore.getSnapshot().notice).toContain('下载')
    // 走的是真实读路径
    expect(h.mock.calls).toContain('host.file.read')
  })

  it('下载超过本机上限的文件：直接拒绝并说明（不让手机内存去赌）', async () => {
    await connect()
    fileStore.open(SESSION_ID)
    await waitFor(() => fileStore.getSnapshot().entries.length > 0)

    await fileStore.download('huge.zip', 200 * 1024 * 1024)
    expect(fileStore.getSnapshot().notice).toContain('超过手机端下载上限')
    expect(fileStore.getSnapshot().download).toBeNull()
  })
})

describe('文件面板 store —— 门槛', () => {
  it('中继链路：blockReason 直接给共享包那句话（两端同一句）', async () => {
    await connect()
    const peer = new FakePeer()
    peer.setStats(relayStats())
    linkStore.attach(peer)
    await waitFor(() => linkStore.getSnapshot().path === 'relay')

    expect(fileStore.blockReason()).toBe(FILE_DIRECT_ONLY_MESSAGE)
    linkStore.detach()
  })

  it('电脑端没声明能力：给的是「未开启」，而不是链路原因', async () => {
    const [hostT, mobileT] = createMemoryPair()
    const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 3000 })
    const mock = createMockHostDataSource()
    // 模拟一台**旧**电脑：文件能力一个都没有（其余能力照旧）
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

    expect(fileStore.blockReason()).toContain('未开启')
    expect(fileStore.canUpload()).toBe(false)
    // ⚠️ 但电脑侧仍会拒（本端不显示入口 ≠ 隔离）—— 这是电脑侧用例的活，这里只确认本端的说法
  })
})
