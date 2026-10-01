/**
 * 行模型单测（§35）—— 消息数组 → 列表的「行」。
 *
 * 这一层之所以必须先落成**纯函数**再让组件用（而不是直接在 JSX 里 `filter`/`slice`）：
 * 它同时是**三个契约**的实现，而这三个都可能悄悄错、错了又是「看起来像 bug」的症状：
 *
 * 1. **合并**（连续工具调用合成一行）：按屏幕上看到的样子判 —— 引擎每轮都先落一条空正文的
 *    assistant 消息，按「数组里紧挨着」判等于不生效；
 * 2. **不丢行**：`rendersNothing` 必须与组件那条 `return null` 同一个判据，否则有内容的行
 *    会被整个丢掉（消息凭空消失）；
 * 3. **稳定 key**：行的 `key` 是列表的记账钥匙（前插改下标不改 key）—— 折叠态与 React 的
 *    渲染都按它记账（见 `MessageList.tsx` 文件头）；
 * 4. **跟随判据**（`tailSignature`）：决定「该不该跟着落底」—— 它必须**对前插不变**
 *    （头动了不算新内容），否则加载更早的消息会把正看历史的用户拽到底部（真机缺陷）。
 */
import { describe, expect, it } from 'vitest'
import type { MessageDTO } from 'virlen-remote'
import {
  buildRows,
  rendersNothing,
  tailSignature,
  toolGroupView,
} from '../lib/message-rows'

/** 造一条消息（只给用例关心的字段）。 */
function msg(
  id: string,
  role: MessageDTO['role'],
  patch: Partial<MessageDTO> = {},
): MessageDTO {
  return { id, role, text: '正文', createdAt: 0, ...patch }
}

const tool = (id: string, text: string, patch: Partial<MessageDTO> = {}) =>
  msg(id, 'tool', { text, ...patch })

/** 行的紧凑描述（断言行结构时比逐字段比对好读）。 */
function shape(messages: readonly MessageDTO[]): string[] {
  return buildRows(messages).map((row) =>
    row.kind === 'one' ? `one:${row.message.id}` : `tools:${row.messages.map((m) => m.id).join(',')}`,
  )
}

describe('rendersNothing：判据必须与组件那条 return null 一致', () => {
  it('空正文的 user / assistant 什么都渲染不出来', () => {
    expect(rendersNothing(msg('a', 'assistant', { text: '' }))).toBe(true)
    expect(rendersNothing(msg('a', 'assistant', { text: '  \n ' }))).toBe(true)
    expect(rendersNothing(msg('u', 'user', { text: '' }))).toBe(true)
    expect(rendersNothing(msg('a', 'assistant'))).toBe(false)
  })

  it('工具 / 系统消息**永远有东西可看**：正文是空串时卡片头仍在（那是「没有输出」要说的话）', () => {
    expect(rendersNothing(tool('t', ''))).toBe(false)
    expect(rendersNothing(msg('s', 'system', { text: '' }))).toBe(false)
  })
})

describe('buildRows：连续工具调用合成一行', () => {
  it('单条工具调用不组（保持原来那张卡）', () => {
    expect(shape([tool('t1', 'a')])).toEqual(['one:t1'])
  })

  it('两条挨着就是一组，行的 key 认首条工具消息（折叠态跟着它走）', () => {
    const rows = buildRows([tool('t1', 'a'), tool('t2', 'b')])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('tools')
    expect(rows[0].key).toBe('tools:t1')
  })

  it('中间夹着空正文的 assistant **不打断**合并（真机上这就是常态：每轮都先落一条空的）', () => {
    expect(
      shape([
        tool('t1', 'a'),
        msg('gap', 'assistant', { text: '' }),
        tool('t2', 'b'),
        msg('gap2', 'assistant', { text: '   ' }),
        tool('t3', 'c'),
      ]),
    ).toEqual(['tools:t1,t2,t3'])
  })

  it('看得见的东西截断一段：有正文的 assistant / user / 系统消息都是边界', () => {
    expect(
      shape([
        tool('t1', 'a'),
        tool('t2', 'b'),
        msg('a1', 'assistant', { text: '看完了' }),
        tool('t3', 'c'),
        msg('u1', 'user', { text: '再来' }),
        tool('t4', 'd'),
        tool('t5', 'e'),
        msg('s1', 'system', { text: '[上下文摘要] …' }),
        tool('t6', 'f'),
      ]),
    ).toEqual([
      'tools:t1,t2',
      'one:a1',
      'one:t3',
      'one:u1',
      'tools:t4,t5',
      'one:s1',
      'one:t6',
    ])
  })

  it('什么都渲染不出来的消息不占行（否则每轮都白白吃掉一个 10px 的空行盒）', () => {
    expect(shape([msg('u1', 'user', { text: '你好' }), msg('gap', 'assistant', { text: '' })])).toEqual([
      'one:u1',
    ])
    // 全是空消息 → 一行都没有（列表走空态，而不是一堆空行盒）
    expect(buildRows([msg('gap', 'assistant', { text: '' })])).toEqual([])
  })

  it('顺序是权威：本函数只做「合并 / 丢弃」两种减法，不重排', () => {
    expect(shape([msg('u1', 'user'), msg('a1', 'assistant'), tool('t1', 'a')])).toEqual([
      'one:u1',
      'one:a1',
      'one:t1',
    ])
  })
})

describe('toolGroupView：折叠态只说「几次 + 多大」', () => {
  it('计数 + 行数合计（行数与单条卡片同一套口径：末尾空行不算）', () => {
    const view = toolGroupView([tool('t1', 'a\nb\n'), tool('t2', 'c'), tool('t3', '')])
    expect(view.label).toBe('3 次工具调用')
    expect(view.size).toBe('共 3 行')
    expect(view.omitted).toBe(false)
  })

  it('全被档位省略 → 报「已省略」，而不是报「共 0 行」', () => {
    const view = toolGroupView([
      tool('t1', '', { detail: 'omitted' }),
      tool('t2', '', { detail: 'omitted' }),
    ])
    expect(view.size).toBe('已省略')
    expect(view.omitted).toBe(true)
  })

  it('真没输出（不是被省略）→ 规模留空，不编造', () => {
    const view = toolGroupView([tool('t1', ''), tool('t2', '   ')])
    expect(view.label).toBe('2 次工具调用')
    expect(view.size).toBe('')
    expect(view.omitted).toBe(false)
  })
})

describe('tailSignature：前插不算「新内容」（否则会打断翻历史）', () => {
  it('空列表 → 空串；单行 → 行 key', () => {
    expect(tailSignature([])).toBe('')
    expect(tailSignature(buildRows([msg('u1', 'user')]))).toBe('u1')
  })

  it('末行是工具组 → 带成员数（只比 key 会漏掉「并进末尾组」那一次跟随）', () => {
    expect(tailSignature(buildRows([tool('t1', 'a'), tool('t2', 'b')]))).toBe('tools:t1#2')
    expect(tailSignature(buildRows([tool('t1', 'a')]))).toBe('t1')
  })

  it('**上拉续页（前插）→ 签名纹丝不动**：用户正看的还是那几条，不该被拽到底部', () => {
    const page = [msg('u3', 'user'), msg('a3', 'assistant'), tool('t1', 'a'), tool('t2', 'b')]
    const withOlder = [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), ...page]
    expect(tailSignature(buildRows(withOlder))).toBe(tailSignature(buildRows(page)))
    // 前插的头一行确实换了（这是「前插」的判据），但尾巴没换
    expect(buildRows(withOlder)[0].key).not.toBe(buildRows(page)[0].key)
  })

  it('前插把更早的工具调用接到**头部**那个组上 → 签名同样不动', () => {
    const page = [tool('t1', 'a'), tool('t2', 'b'), msg('u1', 'user')]
    const withOlder = [tool('t0', 'x'), ...page]
    expect(tailSignature(buildRows(withOlder))).toBe(tailSignature(buildRows(page)))
  })

  it('尾部增长（新消息成行 / 并进末尾组 / 流式气泡换行）→ 签名必须变', () => {
    const before = buildRows([msg('u1', 'user'), tool('t1', 'a'), tool('t2', 'b')])
    // 并进末尾那个组：key 不变，成员数 +1
    const merged = buildRows([msg('u1', 'user'), tool('t1', 'a'), tool('t2', 'b'), tool('t3', 'c')])
    expect(tailSignature(merged)).not.toBe(tailSignature(before))
    // 新消息自己成行
    const appended = buildRows([msg('u1', 'user'), tool('t1', 'a'), tool('t2', 'b'), msg('u2', 'user')])
    expect(tailSignature(appended)).not.toBe(tailSignature(before))
  })
})
