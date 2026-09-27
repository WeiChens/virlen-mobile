/**
 * Service Worker —— 仅提供「可安装」能力，**不做资源缓存**。
 *
 * 理由：手机端与电脑端是**实时链路**，缓存旧的 JS 会造成「代码已更新但手机还跑旧逻辑」
 * 这类极难排查的问题（服务端已发新版、手机上却仍是旧版）。可安装性（installability）
 * 只需要一个带 fetch 监听的 SW，监听体可为空 —— 于是这里让所有请求走默认网络路径。
 *
 * 后续若要离线壳，务必改用「导航 network-first + 带版本号的 precache + 即时激活」。
 */
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// 空 fetch 监听：不拦截、不缓存（保留可安装性所需的最小条件）
self.addEventListener('fetch', () => {})
