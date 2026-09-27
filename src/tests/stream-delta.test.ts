/**
 * §32：手机端的**增量流式合并**。
 *
 * 电脑侧只发新增后缀（`mode='delta'` + `offset`），拼成完整正文是**本端**的责任。
 * 这里的每一条用例都对应一种真机上会出现的落后场景：
 *
 * | 场景 | 帧的形状 | 期望 |
 * |---|---|---|
 * | 正常追加 | `offset == 本地长度` | 追加 |
 * | 重连后收到重复段 | `offset + len ≤ 本地长度` | 丢弃（只推进 seq） |
 * | 部分重叠（拉过全文后又来了旧帧） | `0 < 本地长度 − offset < len` | 只取尾巴 |
 * | 中途订阅 / `reset` 后重拉 | `offset > 本地长度` | **拉全文对齐** |
 *
 * 为什么不能只靠 seq 连续性：seq 对不上只能说明「可能缺帧」，而**缺的内容可能已经在本地**
 * （重复段），也可能真的缺 —— 两者要做出相反的动作，只有 `offset` 能分辨。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostEvents } from 'virlen-remote'

/** 受控的 caller（只供 `host.session.message.get` 用）。 */
const h = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; params: unknown }>,
  /** 下一次拉全文的应答；`null` = 调用失败（旧电脑没这个方法 / 链路断了）。 */
  reply: null as { message: { id: string; text: string } } | null,
}))

vi.mock('../api/active', () => ({
  getCaller: () => ({
    call: async (method: string, params: unknown) => {
      h.calls.push({ method, params })
      if (!h.reply) throw new Error('E_UNSUPPORTED: 老电脑没有这个方法')
      return h.reply
    },
  }),
  // chat.ts 在模块加载时就调它（挂事件订阅）→ 给个 no-op 即可
  onEndpointReady: () => () => {},
}))

const { chatStore } = await import('../store/chat')

const SID = 's-delta'

function frame(patch: Partial<HostEvents['host.event.message.stream']>): HostEvents['host.event.message.stream'] {
  return { sessionId: SID, messageId: 'a1', seq: 1, mode: 'delta', text: '', final: false, ...patch }
}

/** 当前会话的流式正文（未在流式则为 `undefined`）。 */
function live(): { messageId: string; text: string; seq: number } | undefined {
  return chatStore.getSnapshot().streaming[SID]
}

beforeEach(() => {
  h.calls.length = 0
  h.reply = null
  // 清掉上一条用例留下的流式态
  chatStore.applyEvent('host.event.message.stream', frame({ final: true }))
})

describe('applyStreamFrame —— 整帧 / 增量', () => {
  it('整帧：直接替换（老电脑只发整帧，天然兼容）', () => {
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 1, text: '你' }))
    expect(live()).toMatchObject({ messageId: 'a1', text: '你', seq: 1 })
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 2, text: '你好' }))
    expect(live()).toMatchObject({ text: '你好', seq: 2 })
  })

  it('首帧（整段空串）+ 增量：拼成完整正文', () => {
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 1, text: '' }))
    chatStore.applyEvent('host.event.message.stream', frame({ seq: 2, offset: 0, text: '这是' }))
    chatStore.applyEvent('host.event.message.stream', frame({ seq: 3, offset: 2, text: '增量帧' }))
    expect(live()).toMatchObject({ text: '这是增量帧', seq: 3 })
  })

  it('换消息 → 帧里带整段（`mode=full`），旧正文不残留', () => {
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 1, text: '旧' }))
    chatStore.applyEvent('host.event.message.stream', frame({ messageId: 'a2', mode: 'full', seq: 1, text: '新' }))
    expect(live()).toMatchObject({ messageId: 'a2', text: '新' })
  })

  it('重复段：完全覆盖本地 → 丢弃内容、只推进 seq', () => {
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 1, text: '你好' }))
    chatStore.applyEvent('host.event.message.stream', frame({ seq: 2, offset: 0, text: '你好' }))
    expect(live()).toMatchObject({ text: '你好', seq: 2 })
  })

  it('部分重叠：只取尾巴（拉过全文后又来一帧旧的增量）', () => {
    // 本地已有 3 个字（例如刚拉过全文），而这一帧的基准只到第 2 个字：
    // 帧覆盖 [2,4)，本地已覆盖 [0,3) → 只应补上第 3 个字（'界'）
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 1, text: '你好世' }))
    chatStore.applyEvent('host.event.message.stream', frame({ seq: 2, offset: 2, text: '世界' }))
    expect(live()?.text).toBe('你好世界')
  })

  it('final：清空流式态（定稿正文由随后的 `message.added` 落地）', () => {
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 1, text: '半截' }))
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 2, text: '完整', final: true }))
    expect(live()).toBeUndefined()
  })
})

describe('applyStreamFrame —— 缺口与对齐', () => {
  it('真缺一段（offset > 本地长度）→ 拉全文对齐，而不是拼出错位正文', async () => {
    h.reply = { message: { id: 'a1', text: '之前的正文' } }
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 1, text: '你' }))
    // 基准在第 9 个字，而本地只有 1 个字 —— 中间那 8 个字从未收到（中途才订阅的情形）
    chatStore.applyEvent('host.event.message.stream', frame({ seq: 9, offset: 9, text: '后面的' }))

    await vi.waitFor(() => expect(live()?.text).toBe('之前的正文'))
    expect(h.calls).toEqual([
      { method: 'host.session.message.get', params: { sessionId: SID, messageId: 'a1' } },
    ])
  })

  it('对齐之后再来的增量按新基准接上（不会重复触发拉取）', async () => {
    h.reply = { message: { id: 'a1', text: '之前的正文' } } // 长度 5
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 1, text: '你' }))
    chatStore.applyEvent('host.event.message.stream', frame({ seq: 9, offset: 9, text: '后面的' }))
    await vi.waitFor(() => expect(live()?.text).toBe('之前的正文'))

    h.calls.length = 0
    chatStore.applyEvent('host.event.message.stream', frame({ seq: 10, offset: 5, text: '，继续' }))
    expect(live()?.text).toBe('之前的正文，继续')
    expect(h.calls).toHaveLength(0)
  })

  it('拉回来的比手上的短（过期应答）→ 不回退', async () => {
    h.reply = { message: { id: 'a1', text: '短' } }
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 1, text: '手上的更长' }))
    chatStore.applyEvent('host.event.message.stream', frame({ seq: 9, offset: 99, text: 'x' }))

    await vi.waitFor(() => expect(h.calls).toHaveLength(1))
    expect(live()?.text).toBe('手上的更长')
  })

  it('拉不到（旧电脑没有 `host.session.message.get`）→ 静默退化为等整帧，不弹错', async () => {
    h.reply = null
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 1, text: '你' }))
    chatStore.applyEvent('host.event.message.stream', frame({ seq: 9, offset: 9, text: '后面的' }))

    await vi.waitFor(() => expect(h.calls).toHaveLength(1))
    // 不覆盖、不报错；随后若收到整帧就恢复正常
    expect(live()?.text).toBe('你')
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 20, text: '整段正文' }))
    expect(live()?.text).toBe('整段正文')
  })

  it('对齐期间又收到更新的整帧 → 以更新的为准（过期应答不得覆盖）', async () => {
    h.reply = { message: { id: 'a1', text: '旧的全文本' } }
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 1, text: '你' }))
    chatStore.applyEvent('host.event.message.stream', frame({ seq: 9, offset: 9, text: '后面的' }))
    // 应答还没回来，先到了一帧更新的整帧（电脑侧正文被改写）
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 10, text: '改写后的正文' }))

    await vi.waitFor(() => expect(h.calls).toHaveLength(1))
    expect(live()?.text).toBe('改写后的正文')
  })

  it('无 offset 的增量（老式）：seq 连续就追加，跳号就拉全文', async () => {
    chatStore.applyEvent('host.event.message.stream', frame({ mode: 'full', seq: 1, text: '你' }))
    chatStore.applyEvent('host.event.message.stream', frame({ seq: 2, text: '好' }))
    expect(live()?.text).toBe('你好')

    h.reply = { message: { id: 'a1', text: '你好，世界' } }
    chatStore.applyEvent('host.event.message.stream', frame({ seq: 7, text: '跳号了' }))
    await vi.waitFor(() => expect(live()?.text).toBe('你好，世界'))
  })
})
