/**
 * M7（§31）：手机端 ICE —— 解析优先级、降级，以及「连接时真的把解析结果用上」的接线。
 *
 * 为什么要在手机端再测一遍共享包的逻辑：**接线才是本端新增的部分**。
 * 共享包只保证「算得对」，这里保证「算出来的东西确实被交给了 `createTransport`」——
 * 否则就会出现「解析得漂漂亮亮，链路还是裸奔（无 ICE）」这种最隐蔽的失效。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Endpoint,
  ICE_CUSTOM_STORAGE_KEY,
  ICE_REMOTE_STORAGE_KEY,
  createMemoryPair,
  registerHostHandlers,
  type Transport,
} from 'virlen-remote'
import { createMockHostDataSource } from 'virlen-remote/testing'
import { customIceText, resolveIceFor, saveCustomIce } from '../api/ice'
import { connectionStore } from '../store/connection'
import { devicesStore } from '../store/devices'

/**
 * 捕获 `createTransport` 的入参并替换掉真实现（真实现要建 `RTCPeerConnection`）。
 * `vi.hoisted`：`vi.mock` 的工厂会被提升到文件顶部执行，普通顶层变量那时还在 TDZ 里。
 */
const h = vi.hoisted(() => ({
  captured: [] as Array<Record<string, unknown>>,
  next: null as unknown as Transport,
}))

vi.mock('../api/transport', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api/transport')>()
  return {
    ...mod,
    createTransport: (opts: Record<string, unknown>) => {
      h.captured.push(opts)
      if (!h.next) throw new Error('用例忘了设置 h.next')
      return h.next
    },
  }
})

const SIGNAL = 'https://signal.example/api/rtc/'

/** 让 `/ice` 返回指定列表（测试环境里 `fetch` 不存在，必须自己装一个）。 */
function stubIceResponse(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    })),
  )
}

const fetchMock = (): ReturnType<typeof vi.fn> => globalThis.fetch as unknown as ReturnType<typeof vi.fn>

/** 造一个「电脑侧 mock 宿主 + 手机侧 transport」，用来走通 hello。 */
function setupHost() {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mock = createMockHostDataSource({ streamSteps: 1, streamDelayMs: 1 })
  const reg = registerHostHandlers(ep, mock, { deviceName: 'Virlen 电脑（演示）' })
  mock.bind(reg.emit)
  return {
    mobileT,
    dispose: () => {
      reg.dispose()
      ep.dispose()
      hostT.close()
      mobileT.close()
    },
  }
}

let disposeHost: (() => void) | null = null

beforeEach(() => {
  localStorage.clear()
  h.captured.length = 0
  h.next = null as unknown as Transport
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
})

afterEach(() => {
  connectionStore.disconnect()
  disposeHost?.()
  disposeHost = null
  vi.unstubAllGlobals()
})

describe('手机端 ICE 解析（§31）', () => {
  it('服务端下发什么就用什么，并写入本地缓存', async () => {
    stubIceResponse({
      v: 1,
      mode: 'static',
      iceServers: [{ urls: 'stun:a:3478' }, { urls: 'turn:a:3478', username: 'u', credential: 'p' }],
    })

    const resolved = await resolveIceFor(SIGNAL)
    expect(resolved.source).toBe('remote')
    expect(resolved.servers).toHaveLength(2)
    expect(JSON.parse(localStorage.getItem(ICE_REMOTE_STORAGE_KEY)!)).toMatchObject({ servers: resolved.servers })

    // 缓存命中：第二次不再请求
    const spy = fetchMock()
    spy.mockClear()
    const again = await resolveIceFor(SIGNAL)
    expect(again.source).toBe('cache')
    expect(spy).not.toHaveBeenCalled()
  })

  it('没有信令基址（Broadcast 联调）→ 不发请求，退化为仅本机候选', async () => {
    stubIceResponse({ iceServers: [{ urls: 'stun:a:3478' }] })
    const resolved = await resolveIceFor(undefined)
    expect(resolved.source).toBe('none')
    expect(resolved.servers).toEqual([])
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  it('自定义优先：保存后直接用，不再问服务端', async () => {
    stubIceResponse({ iceServers: [{ urls: 'stun:server:3478' }] })
    expect(saveCustomIce('[{"urls":"stun:mine:3478"}]')).toEqual({ ok: true })

    const resolved = await resolveIceFor(SIGNAL)
    expect(resolved.source).toBe('custom')
    expect(resolved.servers).toEqual([{ urls: 'stun:mine:3478' }])
    expect(fetchMock()).not.toHaveBeenCalled()
  })

  it('非法自定义：报错且不落盘；回填时按「没填」处理', () => {
    localStorage.setItem(ICE_CUSTOM_STORAGE_KEY, 'keep-me')
    const bad = saveCustomIce('[{')
    expect(bad.ok).toBe(false)
    // 没被非法输入覆盖（用户还能看到自己原来写了什么）
    expect(localStorage.getItem(ICE_CUSTOM_STORAGE_KEY)).toBe('keep-me')

    localStorage.setItem(ICE_CUSTOM_STORAGE_KEY, '<<"bad')
    expect(customIceText()).toBe('')
  })

  it('服务端不可达 → 未配置 + 提示，而不是抛错', async () => {
    stubIceResponse({}, false)
    const resolved = await resolveIceFor(SIGNAL)
    expect(resolved.source).toBe('none')
    expect(resolved.warning).toBeTruthy()
  })
})

describe('手机端连接接线（§31）', () => {
  it('连接时把解析到的 ICE 交给 createTransport（不是解析完就丢）', async () => {
    stubIceResponse({ iceServers: [{ urls: 'stun:a:3478' }, { urls: 'turn:a:3478', username: 'u', credential: 'p' }] })
    const setup = setupHost()
    disposeHost = setup.dispose
    h.next = setup.mobileT

    const ok = await connectionStore.connect({
      hostId: 'demo-host',
      deviceName: '演示电脑',
      token: 'demo-ticket',
      signalUrl: SIGNAL,
    })

    expect(ok).toBe(true)
    expect(h.captured).toHaveLength(1)
    expect(h.captured[0].signalUrl).toBe(SIGNAL)
    expect(h.captured[0].iceServers).toEqual([
      { urls: 'stun:a:3478' },
      { urls: 'turn:a:3478', username: 'u', credential: 'p' },
    ])
  })

  it('注入 transport（用例 / 联调）时**不**解析 ICE —— 那条路径不建 PeerConnection', async () => {
    stubIceResponse({ iceServers: [{ urls: 'stun:a:3478' }] })
    const setup = setupHost()
    disposeHost = setup.dispose

    const ok = await connectionStore.connect({
      hostId: 'demo-host',
      deviceName: '演示电脑',
      token: 'demo-ticket',
      transport: setup.mobileT,
    })

    expect(ok).toBe(true)
    expect(fetchMock()).not.toHaveBeenCalled()
  })
})
