import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = dirname(fileURLToPath(import.meta.url))
const KEY_PATH = join(root, '.certs/dev-key.pem')
const CERT_PATH = join(root, '.certs/dev-cert.pem')

/**
 * HTTPS 是否可用：证书存在即启用。
 *
 * 为什么需要：手机经 **HTTP + 局域网 IP** 访问时浏览器判定**非安全上下文** →
 * 禁用摄像头（`navigator.mediaDevices` 不存在）与部分 WebRTC 能力。
 * 用自签证书（`.certs/`，含本机 IP 的 SAN）即可让手机成为安全上下文。
 *
 * ⚠️ 自签证书在手机上会提示「不安全」，需手动选择「继续/信任」一次。
 * 证书仅用于**本地真机联调**，不进版本库（见 .gitignore）。
 */
function httpsConfig(): { key: Buffer; cert: Buffer } | undefined {
  if (!existsSync(KEY_PATH) || !existsSync(CERT_PATH)) return undefined
  return { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) }
}

// https://vite.dev/config/
export default defineConfig({
  // 相对基址：便于部署在任意子路径（如 https://virlen.cn/mobile/）而不改资源路径
  base: '/mobile/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  server: {
    // host: true —— 允许手机通过局域网 IP 访问 dev server 进行真机调试
    host: true,
    port: 5179,
    strictPort: false,
    // 有证书则启用 HTTPS（手机扫码需安全上下文）；无证书时保持 HTTP
    ...(httpsConfig() ? { https: httpsConfig() } : {}),
  },
})
