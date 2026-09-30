/**
 * 设置面板（主题 / 界面大小）的接线冒烟用例。
 *
 * 为什么值得写：这一层没有任何算法 —— 错的全是**接线**（点了没反应、面板显示「浅色」而页面
 * 还是深色、切完主题下次打开又变回去）。这些都不抛异常，只会「看起来没生效」。
 * 纯逻辑口径已在 `ui-prefs.test.ts` 钉死，这里只确认**手指点下去会到什么**。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsSheet from '../ui/components/SettingsSheet'
import { prefsStore } from '../store/prefs'
import { defaultDeviceName, resetMobileIdentityCache } from '../lib/identity'
import { parsePrefs } from '../lib/prefs'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STORAGE_KEY = 'virlen.mobile.ui-prefs'

let container: HTMLDivElement | null = null
let root: Root | null = null
let onClose: ReturnType<typeof vi.fn<() => void>>

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(createElement(SettingsSheet, { onClose }))
  })
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 按文案找按钮（面板里就是三段 / 三段，用文案比下标稳）。 */
function button(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent?.trim() === label,
  )
  if (!found) throw new Error(`面板上没有「${label}」按钮`)
  return found
}

const isPressed = (label: string): boolean => button(label).getAttribute('aria-pressed') === 'true'

beforeEach(() => {
  localStorage.clear()
  resetMobileIdentityCache()
  prefsStore.reset()
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.size
  onClose = vi.fn<() => void>()
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
  prefsStore.reset()
})

describe('设置面板', () => {
  it('主题：默认「跟随系统」；点「浅色」立刻换主题并落存储', () => {
    mount()
    expect(isPressed('跟随系统')).toBe(true)

    click(button('浅色'))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(isPressed('浅色')).toBe(true)
    expect(isPressed('跟随系统')).toBe(false)
    expect(parsePrefs(localStorage.getItem(STORAGE_KEY)).theme).toBe('light')

    // 再点回深色：面板的选中态与页面属性都要跟着变（只有一处变就是缺陷）
    click(button('深色'))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(isPressed('深色')).toBe(true)
  })

  it('界面大小：点「大」写进 data-size，并落存储', () => {
    mount()
    expect(isPressed('中')).toBe(true)

    click(button('大'))
    expect(document.documentElement.dataset.size).toBe('l')
    expect(parsePrefs(localStorage.getItem(STORAGE_KEY)).size).toBe('l')

    click(button('小'))
    expect(document.documentElement.dataset.size).toBe('s')
  })

  it('显示本机名称（就是配对时报给电脑的那个名字）', () => {
    mount()
    const deviceKey = localStorage.getItem('virlen.mobile.identity')
    expect(deviceKey).toBeTruthy()
    // 名字带 key 尾号 —— 电脑端列表里靠它区分同一用户的两台手机
    const suffix = (JSON.parse(deviceKey!) as { deviceKey: string }).deviceKey.slice(-4)
    expect(container!.textContent).toContain(suffix)
    expect(defaultDeviceName(JSON.parse(deviceKey!).deviceKey)).toContain(suffix)
  })

  it('点遮罩关闭面板', () => {
    mount()
    click(container!.querySelector('.sheet__backdrop')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
