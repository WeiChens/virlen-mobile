/**
 * 剪贴板写入 —— 带**老式降级**的复制。
 *
 * ## 为什么不能只写 `navigator.clipboard.writeText`
 *
 * 它有两个会静默失效的前提：**安全上下文**（`https` / `localhost`）与**用户手势**。
 * 手机端是 PWA，用户完全可能从**局域网 IP**（`http://192.168.x.x:5173`）打开它 ——
 * 那时 `navigator.clipboard` 是 `undefined`，而 `navigator.clipboard?.writeText(x).then(...)`
 * 会在 `.then` 上抛 `TypeError`（可选链只挡了属性访问，挡不住后面的方法调用）。
 * 结果就是「点了复制，什么都没发生，也没有任何提示」。
 *
 * 所以这里返回**布尔结果**而不是抛错，让调用方能如实告诉用户「复制失败」，而不是默默成功。
 *
 * 降级路径用 `document.execCommand('copy')` + 临时 `textarea`（已废弃但仍是各处唯一可行的兜底）。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  const clipboard = navigator.clipboard
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      /* 权限被拒 / 非安全上下文：落到下面的降级路径 */
    }
  }
  return legacyCopy(text)
}

/**
 * 老式复制（临时 `textarea` + `execCommand`）。
 *
 * 会让出一帧焦点又还回去：`select()` 需要元素在文档里且可获得焦点，而抢焦点会让
 * 输入框的软键盘闪一下（真机上很明显），所以事后把焦点还回原来那个元素。
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement as HTMLElement | null
  const area = document.createElement('textarea')
  area.value = text
  // 不能 display:none（那样选不中）：移出视口即可
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    active?.focus?.()
  }
}
