/**
 * node 测试环境的浏览器 API 桩。
 *
 * 供 `broadcast-e2e.test.ts`（`// @vitest-environment node`）使用：
 * - 该 e2e 必须跑在 **node 环境** —— jsdom 与 Node 的 `Uint8Array` 属不同 realm，
 *   而 jsdom 未实现 `BroadcastChannel`（用的是 Node 的），反序列化出的 `Uint8Array`
 *   在 jsdom realm 下 `instanceof Uint8Array` 为 false → 帧被 `toBytes` 丢弃。
 *   （真实浏览器同 realm，无此问题；这是**测试环境**特有的。）
 * - `devices.ts` 在**模块加载时**即 new（读 localStorage），故本桩必须在它之前执行
 *   —— 由测试文件把它作为**第一个 import** 保证。
 */
class MemStorage implements Storage {
  private readonly map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  clear(): void {
    this.map.clear()
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
}

;(globalThis as unknown as { localStorage: Storage }).localStorage = new MemStorage()

// navigator.userAgent 在 Node ≥ 21 已内置；更早版本兜底一个空实现（detectPlatform 会读它）
if (!('navigator' in globalThis)) {
  ;(globalThis as unknown as { navigator: { userAgent: string } }).navigator = { userAgent: 'node' }
}
