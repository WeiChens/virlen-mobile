import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

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
