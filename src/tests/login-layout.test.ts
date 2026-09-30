/**
 * 登录页**版面契约**的接线用例（本次改版的两条结论，都只能从 DOM 上验证）。
 *
 * 为什么值得写：这两条都是「顺序 / 层级」这类约定 —— 代码里怎么排都跑得起来、也不抛异常，
 * 但用户在手机上感受到的差别很大：
 *
 *  1. **已配对的电脑排在「扫码添加电脑」之前**：配对过一次之后，回到这一页十有八九是连它们。
 *     原来扫码按钮在最上面（页面级大蓝按钮），把真正高频的入口压在下面。纯函数测不到这个，
 *     只能在 DOM 里断言「连接」出现在「扫码添加电脑」**之前**。
 *
 *  2. **品牌区有 logo**：首页要认出「这是 Virlen」，靠的就是它。图片 `alt=""` 是有意的
 *     （旁边的字标已经念出名字，读屏不该重复播报一遍图片）。
 *
 * 顺带钉住一条视觉层级：设备行的主动作（连接）与次要动作（改名 / 删除）**不是同一档样式**
 * —— 三个同权重的实心按钮并排时，点错「删除」的代价是不可逆的。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Login from '../ui/pages/Login'
import { chatStore } from '../store/chat'
import { connectionStore } from '../store/connection'
import { devicesStore } from '../store/devices'

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

/** 按文案找按钮（页面上按钮不少，按下标找太脆）。 */
function button(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent?.trim() === label,
  )
  if (!found) throw new Error(`页面上没有「${label}」按钮`)
  return found
}

/** a 是否排在 b 之前（DOM 文档序）。 */
function before(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

beforeEach(() => {
  chatStore.reset()
  connectionStore.disconnect()
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
  for (const d of devicesStore.getSnapshot()) devicesStore.remove(d.hostKey)
  localStorage.clear()
})

describe('登录页版面', () => {
  it('品牌区渲染 logo（空 alt，不重复念名字）', () => {
    mount()
    const img = container!.querySelector('img')
    expect(img).toBeTruthy()
    // 构建产物带前缀（`base: '/mobile/'`），所以只断言「指到 logo.png」
    expect(img!.getAttribute('src')).toContain('logo.png')
    // 装饰性图片：旁边的字标已经念出「Virlen」，读屏不该重复播报
    expect(img!.getAttribute('alt')).toBe('')
    expect(container!.querySelector('.login__title')?.textContent).toBe('Virlen')
  })

  it('有已配对的电脑时：「连接」排在「扫码添加电脑」之前', () => {
    devicesStore.upsert({ hostKey: HOST_KEY, name: HOST_NAME, grant: 'gt-1', lastConnectedAt: 0 })
    mount()
    // 扫描按钮永远在页面上（它是页面级唯一主动作，也是空列表时的唯一出路）
    expect(before(button('连接'), button('扫码添加电脑'))).toBe(true)
  })

  it('没有已配对的电脑时：空态文案把手指引到扫码按钮', () => {
    mount()
    expect(container!.textContent).toContain('还没有配对过的电脑')
    expect(button('扫码添加电脑').className).toContain('btn--block')
  })

  it('设备行的动作分两档：连接是主动作，改名 / 删除是三级文字动作', () => {
    devicesStore.upsert({ hostKey: HOST_KEY, name: HOST_NAME, grant: 'gt-1', lastConnectedAt: 0 })
    mount()
    expect(button('连接').className).not.toContain('btn--quiet')
    expect(button('改名').className).toContain('btn--quiet')
    expect(button('删除').className).toContain('btn--quiet')
  })
})
