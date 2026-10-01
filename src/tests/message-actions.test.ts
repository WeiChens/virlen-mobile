/**
 * §36 长按菜单的**判定层**用例（纯函数 + 剪贴板降级）。
 *
 * 为什么这些必须钉住：菜单里每一项的**取错**都不会报错，只会静默地骗人 ——
 *  - 旧电脑端给了「引用」→ RPC 成功、引文被丢掉，用户以为引用了而 AI 当没看见；
 *  - 被档位省略的工具输出给了「复制」→ 复制到空串，还回一句「已复制」；
 *  - 会话正在回复时给了可点的「删除」→ 电脑侧报 E_BUSY，用户只看到「删除失败」。
 *
 * 三件外部事实（能力 / 是否回复中）都由调用方喂进来，所以这里的输入就是一个普通对象 ——
 * 不需要挂组件也能把所有分支跑遍（组件级只验「接线」，见 `chat-long-press.test.ts`）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageDTO } from 'virlen-remote'
import {
  copyTextOf,
  COPY_EMPTY_HINT,
  COPY_OMITTED_HINT,
  DELETE_BUSY_HINT,
  deleteMessageConfirmText,
  menuTitlePreview,
  messageRoleLabel,
  planMessageActions,
  truncateCountFrom,
} from '../lib/messages'
import { rendersNothing } from '../lib/message-rows'
import { copyText } from '../lib/clipboard'

const msg = (patch: Partial<MessageDTO> & { role: MessageDTO['role'] }): MessageDTO => ({
  id: 'm',
  text: '',
  createdAt: 0,
  ...patch,
})

/** 能力齐备、会话空闲 —— 大多数用例的基线。 */
const OK = { canQuote: true, canDelete: true, busy: false }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('planMessageActions —— 菜单里有什么、哪项为什么不能点', () => {
  it('用户 / AI 消息：三项齐全（复制 / 引用 / 删除），顺序稳定', () => {
    for (const role of ['user', 'assistant'] as const) {
      const items = planMessageActions(msg({ role, text: '有正文' }), OK)
      expect(items.map((i) => i.action)).toEqual(['copy', 'quote', 'delete'])
      expect(items.every((i) => !i.disabled)).toBe(true)
    }
  })

  it('工具消息：**只给复制** —— 工具结果与发起它的调用是一体两面（电脑侧会拒删）', () => {
    const items = planMessageActions(msg({ role: 'tool', text: '输出', toolName: 'read_file' }), OK)
    expect(items.map((i) => i.action)).toEqual(['copy'])
  })

  it('压缩摘要（system）：可复制、可删除，但**不给引用**（它不是「对话发言」）', () => {
    const items = planMessageActions(msg({ role: 'system', text: '[上下文摘要] 很长' }), OK)
    expect(items.map((i) => i.action)).toEqual(['copy', 'delete'])
  })

  it('电脑端没声明引用能力 → 整项不出现（旧电脑端会静默丢掉引文）', () => {
    const items = planMessageActions(msg({ role: 'user', text: '正文' }), { ...OK, canQuote: false })
    expect(items.map((i) => i.action)).toEqual(['copy', 'delete'])
  })

  it('电脑端没声明删除能力 → 整项不出现（未授权 = E_DENIED）', () => {
    const items = planMessageActions(msg({ role: 'user', text: '正文' }), { ...OK, canDelete: false })
    expect(items.map((i) => i.action)).toEqual(['copy', 'quote'])
  })

  it('会话正在回复中 → 删除仍列出但灰显，并说明原因（不藏起来，否则用户以为功能没了）', () => {
    const items = planMessageActions(msg({ role: 'assistant', text: '正文' }), { ...OK, busy: true })
    const del = items.find((i) => i.action === 'delete')!
    expect(del.disabled).toBe(true)
    expect(del.hint).toBe(DELETE_BUSY_HINT)
    // 另外两项不受影响
    expect(items.filter((i) => !i.disabled).map((i) => i.action)).toEqual(['copy', 'quote'])
  })

  it('正文被档位省略的工具输出：复制灰显 + 明说「被省略」——绝不能谎报「已复制」', () => {
    const items = planMessageActions(
      msg({ role: 'tool', text: '', detail: 'omitted', toolName: 'run_command' }),
      OK,
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ action: 'copy', disabled: true, hint: COPY_OMITTED_HINT })
  })

  it('本来就没正文：复制灰显，但**换一句话**（与「被省略」是两回事）', () => {
    const items = planMessageActions(msg({ role: 'tool', text: '', toolName: 'run_command' }), OK)
    expect(items[0]).toMatchObject({ action: 'copy', disabled: true, hint: COPY_EMPTY_HINT })
    expect(items[0].hint).not.toBe(COPY_OMITTED_HINT)
  })

  it('不认识的完整性标记（将来新增的取值）也算「正文不完整」，不冒充分完整正文', () => {
    const items = planMessageActions(
      msg({ role: 'tool', text: '', detail: 'omitted' }),
      OK,
    )
    expect(items[0].disabled).toBe(true)
  })

  it('空正文的用户消息：引用同样灰显（引用一段空正文没有意义）', () => {
    const items = planMessageActions(msg({ role: 'user', text: '   ' }), OK)
    expect(items.find((i) => i.action === 'quote')).toMatchObject({ disabled: true, hint: COPY_EMPTY_HINT })
  })
})

describe('复制 / 引用 / 删除 用到的三个纯函数', () => {
  it('copyTextOf 去掉首尾空白（引用块本来就不在 text 里，见共享包 MessageDTO.quotes）', () => {
    expect(copyTextOf({ text: '  你好  ' })).toBe('你好')
    expect(copyTextOf({ text: '\n\n' })).toBe('')
  })

  it('truncateCountFrom：含自己；删最后一条 = 1；找不到 = 0（调用方据此拒绝走删除）', () => {
    const list = [msg({ id: 'a', role: 'user' }), msg({ id: 'b', role: 'assistant' }), msg({ id: 'c', role: 'user' })]
    expect(truncateCountFrom(list, 'a')).toBe(3)
    expect(truncateCountFrom(list, 'c')).toBe(1)
    expect(truncateCountFrom(list, 'nope')).toBe(0)
  })

  it('deleteMessageConfirmText：条数要能被核对 —— 不可逆操作不能只说「及其之后的所有消息」', () => {
    expect(deleteMessageConfirmText(1)).toContain('删除这条消息')
    const many = deleteMessageConfirmText(4)
    expect(many).toContain('之后的 3 条')
    expect(many).toContain('共 4 条')
    expect(many).toContain('不可恢复')
  })

  it('menuTitlePreview：有正文取首行 / 工具卡给工具名 / 被省略直说省略', () => {
    expect(menuTitlePreview(msg({ role: 'user', text: '第一行\n第二行' }))).toBe('第一行')
    expect(menuTitlePreview(msg({ role: 'tool', text: '', toolName: 'grep' }))).toBe('grep')
    expect(menuTitlePreview(msg({ role: 'tool', text: '', detail: 'omitted' }))).toBe('（正文被省略）')
    expect(menuTitlePreview(msg({ role: 'assistant', text: '' }))).toBe('（无正文）')
  })

  it('messageRoleLabel：四个角色都有明确说法（不兜底成「未知」）', () => {
    expect(messageRoleLabel('user')).toBe('你')
    expect(messageRoleLabel('assistant')).toBe('AI')
    expect(messageRoleLabel('tool')).toBe('工具')
    expect(messageRoleLabel('system')).toBe('系统')
  })
})

describe('带引用的消息不能被当成「渲染不出东西」（否则引用凭空消失）', () => {
  it('只有引用、正文为空的消息仍占一行', () => {
    expect(rendersNothing(msg({ role: 'user', text: '' }))).toBe(true)
    expect(
      rendersNothing(
        msg({ role: 'user', text: '', quotes: [{ messageId: 'x', role: 'assistant', text: '被引用' }] }),
      ),
    ).toBe(false)
  })
})

describe('copyText —— 剪贴板不可用时必须如实返回失败', () => {
  const stubClipboard = (value: unknown) => {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
  }

  it('空文本直接失败（不去写一个空串再报成功）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard({ writeText })
    expect(await copyText('')).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('navigator.clipboard 可用 → 走它', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard({ writeText })
    expect(await copyText('你好')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('你好')
  })

  it('非安全上下文（clipboard 是 undefined）→ 走降级路径而不是抛 TypeError', async () => {
    stubClipboard(undefined)
    const exec = vi.fn().mockReturnValue(true)
    ;(document as unknown as { execCommand: unknown }).execCommand = exec
    expect(await copyText('你好')).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('两条路都不行 → false（调用方据此提示「复制失败」，而不是静默成功）', async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    ;(document as unknown as { execCommand: unknown }).execCommand = vi.fn().mockReturnValue(false)
    expect(await copyText('你好')).toBe(false)
  })
})
