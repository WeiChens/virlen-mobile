/**
 * 已配对电脑的**本地改名**（`store/devices.ts` 的 `alias`）。
 *
 * 为什么这些断言值得写：改名的失败方式全都**不是报错，而是「过一会儿自己变回去」**——
 *  1. 连接成功时 `upsert()` 会用电脑自报的 `deviceName` 重建整条记录 →
 *     别名存错地方（直接写 `name`）就会「连一次就没了」；
 *  2. 顶栏读的是**连接时固化**的 `device.name` → 只改记录不改这里，
 *     表现是「列表里叫客厅主机，chat 顶栏还是 DESKTOP-ARV3R1J」；
 *  3. `alias` 是用户手输的（可能全空格、可能 300 字）→ 不归一化就会在版式上炸开。
 * 这三条都只在真机上、且要「连一次」才看得见。所以这里用假宿主把整条链路钉住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Endpoint, createMemoryPair, registerHostHandlers } from 'virlen-remote'
import { createMockHostDataSource } from 'virlen-remote/testing'
import { connectionStore } from '../store/connection'
import { chatStore } from '../store/chat'
import { MAX_DEVICE_NAME_LEN, deviceLabel, devicesStore } from '../store/devices'

/**
 * 存储键 —— **故意在这里再写一遍**。
 *
 * 它是与「用户已配对记录」之间的持久化契约：改掉它等于所有老用户的配对记录凭空消失
 * （必须重新扫码）。测试里钉一份，改动时至少会红一次。
 */
const STORAGE_KEY = 'virlen.mobile.devices'

/** 假宿主返回的电脑自报名字（见 `virlen-remote/testing` 的 mock hello）。 */
const HOST_REPORTED_NAME = 'Virlen 电脑（演示）'

const rawList = (): Array<Record<string, unknown>> =>
  JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as Array<Record<string, unknown>>

function seed(hostKey = 'dk-1', name = 'Virlen 电脑'): void {
  devicesStore.upsert({ hostKey, name, grant: `gt-${hostKey}`, lastConnectedAt: 0 })
}

// ───────────────────────────── 纯 store：改名的归一化与持久化 ─────────────────────────────

describe('devicesStore.rename —— 改名的口径', () => {
  it('改名只动显示名，电脑自报的 name 不动', () => {
    seed()
    devicesStore.rename('dk-1', '客厅主机')
    const device = devicesStore.find('dk-1')!
    expect(deviceLabel(device)).toBe('客厅主机')
    // 「我叫它什么」与「它叫什么」是两个字段：后者是电脑的事实，改名不该覆盖它
    expect(device.name).toBe('Virlen 电脑')
  })

  it('前后空格被去掉；超长被截断到上限', () => {
    seed()
    devicesStore.rename('dk-1', '  客厅主机  ')
    expect(devicesStore.find('dk-1')!.alias).toBe('客厅主机')

    devicesStore.rename('dk-1', 'x'.repeat(MAX_DEVICE_NAME_LEN + 50))
    expect(devicesStore.find('dk-1')!.alias).toHaveLength(MAX_DEVICE_NAME_LEN)
  })

  it('留空 / 全空格 = 恢复电脑原名（字段直接消失，不是存空串）', () => {
    seed()
    devicesStore.rename('dk-1', '客厅主机')
    devicesStore.rename('dk-1', '   ')
    const device = devicesStore.find('dk-1')!
    expect(device.alias).toBeUndefined()
    expect(deviceLabel(device)).toBe('Virlen 电脑')
    // 持久化里也不该留下 alias 键（否则「有没有改过名」变成无法回答的问题）
    expect(rawList()[0]).not.toHaveProperty('alias')
  })

  it('与电脑原名一模一样的别名 = 没改（不留冗余字段）', () => {
    seed()
    devicesStore.rename('dk-1', 'Virlen 电脑')
    expect(devicesStore.find('dk-1')!.alias).toBeUndefined()
  })

  it('对不存在的设备改名：不报错、也不凭空造一条记录', () => {
    devicesStore.rename('dk-none', '幽灵')
    expect(devicesStore.getSnapshot()).toHaveLength(0)
  })
})

describe('devicesStore.upsert —— 用户的名字不能被连接冲掉', () => {
  it('连接成功后的刷新（新凭证 + 重报的名字）保住别名', () => {
    seed()
    devicesStore.rename('dk-1', '客厅主机')
    // 模拟一次成功的连接：upsert 重建记录（凭证续期、电脑重报自己的名字）
    devicesStore.upsert({ hostKey: 'dk-1', name: HOST_REPORTED_NAME, grant: 'gt-1-new', lastConnectedAt: 123 })
    const device = devicesStore.find('dk-1')!
    expect(device.alias).toBe('客厅主机')
    expect(deviceLabel(device)).toBe('客厅主机')
    expect(device.grant).toBe('gt-1-new')
    // 电脑端自己改了名字 → 列表里的「原名」要跟着变（这正是分开两个字段的意义）
    expect(device.name).toBe(HOST_REPORTED_NAME)
  })

  it('调用方显式带了 alias 则听调用方的（将来同步 / 导入用得上）', () => {
    seed()
    devicesStore.rename('dk-1', '客厅主机')
    devicesStore.upsert({
      hostKey: 'dk-1',
      name: 'Virlen 电脑',
      alias: '书房那台',
      grant: 'gt-1',
      lastConnectedAt: 0,
    })
    expect(deviceLabel(devicesStore.find('dk-1')!)).toBe('书房那台')
  })
})

describe('别名持久化 —— 重新读上来仍然生效', () => {
  it('写进 localStorage 的别名能被一份**全新的** store 读回来', async () => {
    seed()
    devicesStore.rename('dk-1', '客厅主机')
    expect(rawList()[0].alias).toBe('客厅主机')

    /*
     * `devicesStore` 是模块级单例，构造时读一次 localStorage —— 要验证「读回来」这条路，
     * 只能重置模块再 import 一份新的（不是 `new`，那会绕过构造函数里的 read()）。
     */
    vi.resetModules()
    const fresh = await import('../store/devices')
    const device = fresh.devicesStore.find('dk-1')!
    expect(fresh.deviceLabel(device)).toBe('客厅主机')
  })

  it('手改 / 旧数据里的空白别名按「没改」处理', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ hostKey: 'dk-x', name: '电脑', grant: 'gt-x', lastConnectedAt: 0, alias: '   ' }]),
    )
    vi.resetModules()
    const fresh = await import('../store/devices')
    expect(fresh.devicesStore.find('dk-x')!.alias).toBeUndefined()
  })
})

// ───────────────────────────── 端到端：改完名再连一次 ─────────────────────────────

interface Harness {
  dispose: () => void
}

/** 用内存链连一台假电脑；返回清理函数。 */
async function connectOnce(): Promise<Harness> {
  const [hostT, mobileT] = createMemoryPair()
  const ep = new Endpoint({ transport: hostT, defaultTimeoutMs: 2000 })
  const mock = createMockHostDataSource()
  const reg = registerHostHandlers(ep, mock, { deviceName: HOST_REPORTED_NAME })
  mock.bind(reg.emit)

  const ok = await connectionStore.connect({
    hostId: 'demo-host',
    deviceName: '演示电脑',
    token: 'demo-token',
    transport: mobileT,
  })
  expect(ok).toBe(true)

  return {
    dispose: () => {
      connectionStore.disconnect()
      reg.dispose()
      ep.dispose()
      hostT.close()
      mobileT.close()
    },
  }
}

describe('端到端 —— 改名后重连仍然用本地名字', () => {
  it('第一次连接记下电脑原名；改名后重连，顶栏与列表都用新名字', async () => {
    const first = await connectOnce()
    // 首次连接：记录里是电脑自报的名字，顶栏同款
    expect(devicesStore.find('demo-host')!.name).toBe(HOST_REPORTED_NAME)
    expect(deviceLabel(devicesStore.find('demo-host')!)).toBe(HOST_REPORTED_NAME)
    expect(connectionStore.getSnapshot().device?.name).toBe(HOST_REPORTED_NAME)

    // 在登录页列表上改名
    devicesStore.rename('demo-host', '客厅主机')
    // 顶栏读的是**连接时固化**的快照，不会当场变（改名的入口在登录页，改完下次连接生效）
    expect(connectionStore.getSnapshot().device?.name).toBe(HOST_REPORTED_NAME)
    first.dispose()

    const second = await connectOnce()
    expect(connectionStore.getSnapshot().device?.name).toBe('客厅主机')
    const after = devicesStore.find('demo-host')!
    // 别名保住了，且**没有**把别名当成电脑自报的名字写进 name
    expect(after).toMatchObject({ alias: '客厅主机', name: HOST_REPORTED_NAME })
    second.dispose()
  })
})

beforeEach(() => {
  chatStore.reset()
  connectionStore.disconnect()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
})

afterEach(() => {
  connectionStore.disconnect()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
  vi.resetModules()
})
