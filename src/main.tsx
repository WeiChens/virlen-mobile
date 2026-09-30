import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { prefsStore } from './store/prefs'
import { refreshMobileIdentity } from './lib/identity'
// 主题令牌必须在 index.css **之前**：index.css 的样式全部引用令牌，
// 而 `color-scheme`（决定滚动条 / 输入框光标 / 原生控件的深浅）只在 theme.css 里定义。
import './theme.css'
import './index.css'

/*
 * 偏好（主题 / 界面大小）必须在**渲染之前**落到 `<html>` 上。
 * 晚一步就会出现「先闪一下深色，再变成浅色」——手机上这个闪烁格外刺眼。
 */
prefsStore.init()

/*
 * 顺手探测一次机型（异步，失败不影响任何功能）：配对时报给电脑的名字用它
 * （`Pixel 7 · 1a2b` 而不是「Android 手机 · 1a2b」）。不 await ——
 * 它只影响「电脑端列表里显示什么名字」，不该挡住首屏。
 */
void refreshMobileIdentity()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// PWA：仅注册「可安装」用的空 Service Worker（不做缓存，见 public/sw.js）。
// 仅生产环境注册，避免 dev 期间 SW 干扰热更新。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 注册失败不影响使用 */
    })
  })
}
