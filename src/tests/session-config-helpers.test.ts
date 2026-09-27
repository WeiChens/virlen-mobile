/**
 * 手机端纯逻辑单测：会话分组 + 消息渲染规则（§22）。
 *
 * 这两组都是**纯函数**（没有 store、没有协议），因此是手机端少数能自动化验证的
 * UI 逻辑 —— `virlen-mobile` 的测试面本来就在 stores / lib 层（见文档 §21.4 的如实说明）：
 * 组件级渲染没有自动化用例，所以「哪些消息渲染成什么」必须先落到纯函数上，再让组件只是调用它。
 */
import { describe, expect, it } from 'vitest'
import type { SessionSummaryDTO } from 'virlen-remote'
import { baseNameOf, groupSessions } from '../lib/session-groups'
import {
  contextPercent,
  formatTokens,
  hasBody,
  pendingLabel,
  toolLabel,
  toolPreview,
} from '../lib/messages'

function session(patch: Partial<SessionSummaryDTO> & { id: string }): SessionSummaryDTO {
  return { title: patch.id, updatedAt: 0, ...patch }
}

describe('groupSessions —— 抽屉分组', () => {
  // 电脑侧给的就是「置顶优先 → updatedAt 倒序」，顺序本身是权威，不要在这里重排
  const list: SessionSummaryDTO[] = [
    session({ id: 'a', agentId: 'ag-1', agentName: 'Virlen', workspace: 'E:/code/app' }),
    session({ id: 'b', agentId: 'ag-2', agentName: '评审员', workspace: 'E:/code/app' }),
    session({ id: 'c', agentId: 'ag-1', agentName: 'Virlen', workspace: 'E:/other/ws' }),
    session({ id: 'd' }),
  ]

  it('按 Agent 分组：组按首次出现顺序，组内保持原序', () => {
    const groups = groupSessions(list, 'agent')
    expect(groups.map((g) => g.label)).toEqual(['Virlen', '评审员', '默认 Agent'])
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['a', 'c'])
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['b'])
    // 没有 agentId 的会话（老数据 / 默认 Agent）不能被丢掉
    expect(groups[2].sessions.map((s) => s.id)).toEqual(['d'])
  })

  it('按工作目录分组：无目录单独成组（标签可读，而不是空标题）', () => {
    const groups = groupSessions(list, 'workspace')
    expect(groups.map((g) => g.label)).toEqual([
      'E:/code/app',
      'E:/other/ws',
      '未设置工作目录',
    ])
    expect(groups[0].sessions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(groups[2].sessions.map((s) => s.id)).toEqual(['d'])
  })

  it('空列表 → 空分组（抽屉显示「还没有会话」，不抛错）', () => {
    expect(groupSessions([], 'agent')).toEqual([])
  })

  it('baseNameOf：取末级目录名（Windows 路径也用 / 归一化过）', () => {
    expect(baseNameOf('E:/code/virlen')).toBe('virlen')
    expect(baseNameOf('E:')).toBe('E:')
  })
})

describe('消息渲染规则', () => {
  it('hasBody：空白正文视为没有（纯工具调用轮不渲染空气泡）', () => {
    expect(hasBody({ text: '' })).toBe(false)
    expect(hasBody({ text: '   \n  ' })).toBe(false)
    expect(hasBody({ text: '正文' })).toBe(true)
  })

  it('toolLabel：有工具名就带上，没有就只显示「工具」（不猜）', () => {
    expect(toolLabel({ text: '', role: 'tool', id: 't', createdAt: 0, toolName: 'read_file' })).toBe(
      '工具 · read_file',
    )
    expect(toolLabel({ text: '', role: 'tool', id: 't', createdAt: 0 })).toBe('工具')
  })

  it('toolPreview：取第一行非空文本并截断；全空时给出可读占位', () => {
    const base = { role: 'tool' as const, id: 't', createdAt: 0 }
    expect(toolPreview({ ...base, text: '\n\n第一行\n第二行' })).toBe('第一行')
    expect(toolPreview({ ...base, text: 'x'.repeat(100) })).toHaveLength(61) // 60 + 省略号
    expect(toolPreview({ ...base, text: '\n \n' })).toBe('(无输出)')
  })

  it('contextPercent：未知占用返回 null（未知 ≠ 0%），超过窗口封顶 100', () => {
    expect(contextPercent(null, 200_000)).toBeNull()
    expect(contextPercent(100_000, 200_000)).toBe(50)
    expect(contextPercent(400_000, 200_000)).toBe(100)
    expect(contextPercent(1_000, 0)).toBeNull()
  })

  it('formatTokens：与桌面 token 环同一口径', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(200_000)).toBe('200k')
    expect(formatTokens(12_500)).toBe('12.5k')
  })

  it('pendingLabel：有工具进度就说出「正在生成什么」（§27），拿不到就退化', () => {
    // 无进度：保留原来的两句（引擎在参数累积期没有事件时，手机端确实无从知道细节）
    expect(pendingLabel({ streaming: true })).toBe('正在思考…')
    expect(pendingLabel({ streaming: false })).toBe('AI 正在处理…')
    // 有进度：说出工具名与已生成字符数 —— 这正是「10 秒空窗」里唯一的可信信号
    expect(
      pendingLabel({ streaming: true, toolProgress: { name: 'write_file', chars: 1200 } }),
    ).toBe('正在生成工具调用 write_file · 1.2k 字符…')
    // 名字拿不到（provider 未给）→ 不编造，退回原文案
    expect(pendingLabel({ streaming: false, toolProgress: { name: '', chars: 999 } })).toBe(
      'AI 正在处理…',
    )
    // 字符数还是 0（刚开工）→ 不显示「0 字符」这种噪音
    expect(pendingLabel({ streaming: true, toolProgress: { name: 'read_file', chars: 0 } })).toBe(
      '正在生成工具调用 read_file…',
    )
  })
})
