import { defineConfig } from 'vitest/config'

/**
 * 手机端单测配置。
 *
 * 用 **jsdom** 环境：`store/connection` 读 `navigator.userAgent`、`store/devices` 用 `localStorage`
 * （jsdom 均提供）。传输层在测试里由 `connectionStore.connect({ transport })` 注入 **memory transport**，
 * 因此不依赖 `BroadcastChannel` / WebRTC。
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
})
