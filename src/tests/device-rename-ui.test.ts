/**
 * 改名 UI 的接线冒烟用例（登录页设备行内编辑）。
 *
 * 为什么值得写：这一层没有任何算法，错的全是**接线**——按钮点不开、输入框改了值但没进 state、
 * 保存写回了 store 但列表读的还是 `name`…… 这些都不会抛异常，只会「点了没反应」。
 * 纯逻辑口径已在 `device-rename.test.ts` 钉死，这里只确认**手指点下去会到什么**。
 *
 * ⚠️ 破例说明（与 §21.4 的取舍一致）：本仓 UI 逻辑一律先落成纯函数，
 * 这里只对「行内编辑」这一处交互破例 —— 它没有可抽的纯函数，只有事件接线。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Login from '../ui/pages/Login'
import { chatStore } from '../store/chat'
import { connectionStore } from '../store/connection'
import { deviceLabel, devicesStore } from '../store/devices'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOST_KEY = 'dk-1'
const HOST_NAME = 'Virlen 电脑'

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(Login))
  })
}

const text = (): string => container?.textContent ?? ''

function button(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent?.trim() === label,
  )
  if (!found) throw new Error(`页面上没有「${label}」按钮`)
  return found
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function input(): HTMLInputElement {
  const el = container?.querySelector('input')
  if (!el) throw new Error('改名输入框没出现')
  return el as HTMLInputElement
}

/**
 * 往受控输入框里打字。
 *
 * 必须走原型上的 setter：React 在 `input` 节点上装了 value 追踪器，直接给 `node.value`
 * 赋值会被它判成「值没变」而丢掉这次 onChange（testing-library 内部也是这么做的）。
 */
function type(value: string): void {
  const el = input()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string): void {
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

beforeEach(() => {
  chatStore.reset()
  connectionStore.disconnect()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
  devicesStore.upsert({ hostKey: HOST_KEY, name: HOST_NAME, grant: 'gt-1', lastConnectedAt: 0 })
  mount()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
})

describe('登录页 —— 设备行内改名', () => {
  it('「改名」→ 输入 → 保存：列表当场用新名字，并把原名标出来', () => {
    // 没改名前不显示「原名」（与上面那行逐字相同，只是噪音）
    expect(text()).toContain(HOST_NAME)
    expect(text()).not.toContain('原名')

    click(button('改名'))
    // 预填**当前显示的名字**（不是在原名上重打一遍）
    expect(input().value).toBe(HOST_NAME)

    type('客厅主机')
    click(button('保存'))

    expect(deviceLabel(devicesStore.find(HOST_KEY)!)).toBe('客厅主机')
    expect(text()).toContain('客厅主机')
    // 原名要留着：改完名之后「这到底是哪台」全靠它
    expect(text()).toContain(`原名 ${HOST_NAME}`)
    // 编辑态已收起
    expect(container?.querySelector('input')).toBeNull()
  })

  it('回车 = 保存（手机软键盘上没有鼠标可点）', () => {
    click(button('改名'))
    type('书房主机')
    press('Enter')
    expect(deviceLabel(devicesStore.find(HOST_KEY)!)).toBe('书房主机')
  })

  it('Esc / 「取消」都不写库', () => {
    click(button('改名'))
    type('打错的名字')
    press('Escape')
    expect(devicesStore.find(HOST_KEY)!.alias).toBeUndefined()

    click(button('改名'))
    type('又一个打错的')
    click(button('取消'))
    expect(devicesStore.find(HOST_KEY)!.alias).toBeUndefined()
    expect(text()).toContain(HOST_NAME)
  })

  it('清空后保存 = 恢复原名（「原名」那行也跟着收起来）', () => {
    click(button('改名'))
    type('客厅主机')
    click(button('保存'))
    expect(text()).toContain('原名')

    click(button('改名'))
    type('')
    click(button('保存'))

    expect(devicesStore.find(HOST_KEY)!.alias).toBeUndefined()
    expect(text()).not.toContain('原名')
    expect(text()).toContain(HOST_NAME)
  })
})
