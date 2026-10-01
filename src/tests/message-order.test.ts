/**
 * 消息顺序（§37）：`message.added` 必须插到**时间序正确的位置**，而不是无脑追加。
 *
 * 为什么值得一个专门的用例：电脑侧把**向前回补的更早历史**也发成 `message.added`
 * （它自己的窗口前插了那一页，而 `store-bridge` 的 diff 只按 id 判断「见过没有」）。
 * 手机端若一律追加，用户点「加载更早的消息」/ 上拉续页后，历史会出现在**最下面**。
 *
 * ⚠️ 这条路径**只有真机才跑得到**：mock host 不模拟 `store-bridge` 的 diff 推送，
 * 所以 `chat-load-older.test.ts`（走续页 RPC 应答那条路径）**永远是绿的** ——
 * 两条路径在真机上并行且竞争（谁先到取决于传输耗时），这个文件补的就是另一条。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { MessageDTO } from 'virlen-remote'
import { chatStore } from '../store/chat'
import { dedupeMessages, insertionIndexFor } from '../lib/messages'

/** 造一条消息：`createdAt` 直接用序号，便于断言顺序。 */
function msg(id: string, n: number): MessageDTO {
  return { id, role: 'user', text: id, createdAt: n }
}

/**
 * 电脑侧逐条推 `added` —— `store-bridge.diffMessages` 就是这么发的
 * （按它窗口里的升序遍历，一条一个事件）。
 */
function pushAdded(sessionId: string, messages: readonly MessageDTO[]): void {
  for (const message of messages) {
    chatStore.applyEvent('host.event.message.added', { sessionId, message })
  }
}

const ids = (sessionId: string): string[] =>
  (chatStore.getSnapshot().messages[sessionId] ?? []).map((m) => m.id)

beforeEach(() => {
  chatStore.reset()
})

describe('insertionIndexFor：按 createdAt 找位置', () => {
  it('空窗口 → 0；比谁都新 → 尾部（正常新消息走的就是这条）', () => {
    expect(insertionIndexFor([], msg('a', 5))).toBe(0)
    expect(insertionIndexFor([msg('a', 1), msg('b', 2)], msg('c', 3))).toBe(2)
  })

  it('更早的历史 → 插到前面，而不是追加', () => {
    const list = [msg('m70', 70), msg('m71', 71)]
    expect(insertionIndexFor(list, msg('m20', 20))).toBe(0)
    // 时间戳相同 → 插在它**之后**（同批消息的相对顺序保持稳定）
    expect(insertionIndexFor(list, msg('m70b', 70))).toBe(1)
    expect(insertionIndexFor(list, msg('m69c', 69))).toBe(0)
  })

  it('乱序到达也能落到正确位置（两页在途交错）', () => {
    const list = [msg('a', 1), msg('c', 3)]
    expect(insertionIndexFor(list, msg('b', 2))).toBe(1)
  })
})

describe('message.added：向前回补的历史也必须落在前面', () => {
  const S = 'x'

  it('先有尾部窗口，再推更早的一页（电脑侧 diff 的路径）→ 顺序仍是升序', () => {
    pushAdded(S, [msg('m70', 70), msg('m71', 71), msg('m72', 72)])
    // 真机上这一批与续页 RPC 的应答**同时在途**；这里模拟「推送先到」
    pushAdded(S, [msg('m20', 20), msg('m21', 21)])
    expect(ids(S)).toEqual(['m20', 'm21', 'm70', 'm71', 'm72'])
  })

  it('同一页内也反序到达（m21 先于 m20）→ 仍然升序', () => {
    pushAdded(S, [msg('m70', 70)])
    pushAdded(S, [msg('m21', 21)])
    pushAdded(S, [msg('m20', 20)])
    expect(ids(S)).toEqual(['m20', 'm21', 'm70'])
  })

  it('首次订阅：电脑侧把整窗按升序推来 → 天然正确（回归：别把正常路径改坏）', () => {
    pushAdded(S, [msg('a', 1), msg('b', 2), msg('c', 3)])
    expect(ids(S)).toEqual(['a', 'b', 'c'])
  })

  it('正常新消息（时间戳最新）仍追加在尾部', () => {
    pushAdded(S, [msg('a', 1), msg('b', 2)])
    pushAdded(S, [msg('c', 3)])
    expect(ids(S)).toEqual(['a', 'b', 'c'])
  })

  it('同 id 幂等：重复推送（应答 + 推送两条路径都到了）不会产生重复消息', () => {
    pushAdded(S, [msg('m70', 70)])
    pushAdded(S, [msg('m20', 20)])
    pushAdded(S, [msg('m20', 20), msg('m70', 70)])
    expect(ids(S)).toEqual(['m20', 'm70'])
  })
})

/*
 * 窗口归一化（2026-11 真机）：控制台报 `Encountered two children with the same key` ——
 * 消息窗口里出现了同 id 的两条。React 对 key 唯一是**硬要求**：重复 key 会报
 * `Encountered two children with the same key`，也会让折叠态张冠李戴，
 * 一条重复就能把视图甩走。
 *
 * 而重复进得来——本地两条写入通道都按 id 判过重（见上），能带进来的只有电脑侧直接给的
 * 窗口数组（快照 / 续页应答）。此处的纯函数是那两个入口共用的归一化。
 */
describe('dedupeMessages：窗口归一化', () => {
  it('按 id 去重，保留**首次出现**的那一条与它的位置', () => {
    const first = msg('a', 1)
    const later = { ...msg('a', 9), text: '后来的那一份' }
    const out = dedupeMessages([first, msg('b', 2), later])
    expect(out.map((m) => m.id)).toEqual(['a', 'b'])
    // 位置与内容取自同一份快照（同一 id 的两条本应内容一致；内容更新走 `message.updated`）
    expect(out[0]).toBe(first)
  })

  it('没有重复时**原样返回入参**（它在渲染路径上每帧都跑，不能白换引用）', () => {
    const list = [msg('a', 1), msg('b', 2)]
    expect(dedupeMessages(list)).toBe(list)
  })

  it('空窗口 / 单条消息：直接快路返回', () => {
    const one = [msg('a', 1)]
    expect(dedupeMessages([])).toEqual([])
    expect(dedupeMessages(one)).toBe(one)
  })

  it('重复**不相邻**也挡得住（电脑侧窗口重叠长这样：整页又被插了一遍）', () => {
    const page = [msg('p1', 1), msg('p2', 2), msg('p3', 3)]
    const out = dedupeMessages([...page, msg('z', 4), ...page])
    expect(out.map((m) => m.id)).toEqual(['p1', 'p2', 'p3', 'z'])
  })
})
