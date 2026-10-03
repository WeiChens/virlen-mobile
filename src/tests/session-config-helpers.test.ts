/**
 * 手机端纯逻辑单测：会话分组 + 消息渲染规则（§22）。
 *
 * 这两组都是**纯函数**（没有 store、没有协议），因此是手机端少数能自动化验证的
 * UI 逻辑 —— `virlen-mobile` 的测试面本来就在 stores / lib 层（见文档 §21.4 的如实说明）：
 * 组件级渲染没有自动化用例，所以「哪些消息渲染成什么」必须先落到纯函数上，再让组件只是调用它。
 */
import { describe, expect, it } from 'vitest'
import type { SessionSummaryDTO } from 'virlen-remote'
import { baseNameOf, groupNeedsAttention, groupSessions } from '../lib/session-groups'
import {
  contextPercent,
  countLines,
  firstLinePreview,
  formatTokens,
  hasBody,
  isDetailOmitted,
  pendingLabel,
  systemLabel,
  toolView,
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

  it('groupNeedsAttention：组内有工作中 / 含当前会话 → 收起态需要提醒', () => {
    const [g1, g2] = groupSessions(
      [
        session({ id: 'a', agentId: 'ag-1', agentName: 'Virlen', working: true }),
        session({ id: 'b', agentId: 'ag-2', agentName: '评审员' }),
      ],
      'agent',
    )
    // 组里有会话在干活 → 提醒（哪怕没在看它）
    expect(groupNeedsAttention(g1, null)).toBe(true)
    // 组里含当前会话 → 提醒（哪怕没在干活）
    expect(groupNeedsAttention(g2, 'b')).toBe(true)
    // 既没干活也不是当前会话 → 不提醒
    expect(groupNeedsAttention(g2, 'a')).toBe(false)
    expect(groupNeedsAttention(g2, null)).toBe(false)
  })
})

describe('消息渲染规则', () => {
  it('hasBody：空白正文视为没有（纯工具调用轮不渲染空气泡）', () => {
    expect(hasBody({ text: '' })).toBe(false)
    expect(hasBody({ text: '   \n  ' })).toBe(false)
    expect(hasBody({ text: '正文' })).toBe(true)
  })

  it('toolView：有工具名就用它，没解析到就是 null（不猜）', () => {
    const base = { role: 'tool' as const, id: 't', createdAt: 0, text: 'src/index.ts' }
    expect(toolView({ ...base, toolName: 'read_file' }).name).toBe('read_file')
    expect(toolView(base).name).toBeNull()
  })

  it('toolView：入参摘要原样用电脑侧给的那一行（手机端不拼、也不从正文反推）', () => {
    const base = { role: 'tool' as const, id: 't', createdAt: 0, text: 'staged files...' }
    // 2026-10 真机反馈：只有工具名时，用户看不出这一步动的是哪个文件 / 跑的什么命令
    expect(
      toolView({ ...base, toolName: 'edit_file', toolArgs: 'src/store/chat.ts · 减少 2行,新增 3行' })
        .args,
    ).toBe('src/store/chat.ts · 减少 2行,新增 3行')
    expect(toolView({ ...base, toolName: 'execute_command', toolArgs: 'npm run build' }).args).toBe(
      'npm run build',
    )
    // 旧电脑端 / 跨页工具调用：字段缺席 → null，卡片就不显示这一行
    expect(toolView(base).args).toBeNull()
  })

  it('toolView：展开区的完整入参原样转交（电脑侧已按 5000 中间省略过）', () => {
    const base = { role: 'tool' as const, id: 't', createdAt: 0, text: '已写入' }
    const full = '{\n  "path": "src/a.ts",\n  "content": "x"\n}'
    // 2026-10 真机反馈的第二轮：「入参显示不完整」—— 摘要只挑主参数，展开区给入参本身
    const view = toolView({
      ...base,
      toolName: 'write_file',
      toolArgs: 'src/a.ts · 写入 1 行',
      toolArgsFull: full,
    })
    expect(view.args).toBe('src/a.ts · 写入 1 行')
    expect(view.argsFull).toBe(full)

    // 中间省略的标记照原样显示：手机端不解释也不修剪（那一行就是「被砍过」的凭证）
    const elided = 'A\n\n…（中间省略 1200 字符）…\n\nB'
    expect(toolView({ ...base, toolArgsFull: elided }).argsFull).toBe(elided)

    // 旧电脑端 / 跨页工具调用 / 无参数的工具 → null，展开区不渲染这一块
    expect(toolView(base).argsFull).toBeNull()
  })

  it('toolView：入参摘要有无都不影响规模口径（空输出仍不报行数）', () => {
    const noBody = toolView({
      role: 'tool',
      id: 't',
      createdAt: 0,
      text: '  ',
      toolArgs: 'src/a.ts',
      toolArgsFull: '{\n  "path": "src/a.ts"\n}',
    })
    expect(noBody.size).toBe('')
    expect(noBody.meta).toBe('')
    expect(noBody.args).toBe('src/a.ts')
    expect(noBody.argsFull).toBe('{\n  "path": "src/a.ts"\n}')
  })

  it('toolView：规模给出行数与字符数（行数扣掉末尾空行）', () => {
    // 工具输出几乎都以换行结尾：不扣掉的话每条都多报一行
    const view = toolView({
      role: 'tool',
      id: 't',
      createdAt: 0,
      toolName: 'list_files',
      text: 'src/index.ts\nsrc/store.ts\nsrc/ui/pages/Chat.tsx\n',
    })
    expect(view.size).toBe('3 行')
    // 48 = 三行内容 + 三个换行（字符数是**原始正文**的，不做任何修剪）
    expect(view.meta).toBe('3 行 · 48 字符')
  })

  it('toolView：没有正文就不报规模（展开后显示「没有输出」，不是「0 行」）', () => {
    for (const text of ['', '  \n  ', '\n\n']) {
      const view = toolView({ role: 'tool', id: 't', createdAt: 0, text })
      expect(view.size).toBe('')
      expect(view.meta).toBe('')
      // 没正文也**不**是「被省略」（§33）：两者相反（真没输出 vs 有输出但没下发）
      expect(view.omitted).toBe(false)
    }
  })

  /*
   * §33：被传输档位省略的工具输出 —— 折叠态就得报「已省略」。
   *
   * 为什么这一条特别重要：它与「空输出」在 DOM 里长得一模一样（正文都是空串），
   * 区分它们的**只有电脑端打的那个标记**。不看标记就必然给其中一种情形写假话。
   */
  it('toolView：被档位省略 → 折叠态报「已省略」，而不是装作没输出', () => {
    const view = toolView({ role: 'tool', id: 't', createdAt: 0, toolName: 'run_command', text: '', detail: 'omitted' })
    expect(view.omitted).toBe(true)
    expect(view.size).toBe('已省略')
    expect(view.meta).toBe('')
    // 工具名照旧：这一步「调了什么」不在裁掉的范围内
    expect(view.name).toBe('run_command')
  })

  it('isDetailOmitted：认「有没有标记」，不穷举取值（将来加「截断」等档位时旧客户端也不撒谎）', () => {
    expect(isDetailOmitted({})).toBe(false)
    expect(isDetailOmitted({ detail: undefined })).toBe(false)
    expect(isDetailOmitted({ detail: 'omitted' })).toBe(true)
    // 不认识的完整性标记：仍按「正文不完整」处理
    expect(isDetailOmitted({ detail: 'truncated' } as unknown as { detail: 'omitted' })).toBe(true)
  })

  it('countLines：末尾空行不算，全空算 0 行', () => {
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb\n\n\n')).toBe(2)
    expect(countLines('a')).toBe(1)
    expect(countLines('   \n ')).toBe(0)
  })

  it('firstLinePreview：只给一行且超长截断（折叠头只有一行，换行一律丢掉）', () => {
    expect(firstLinePreview('\n\n第一行\n第二行')).toBe('第一行')
    expect(firstLinePreview('x'.repeat(100))).toHaveLength(61) // 60 + 省略号
    expect(firstLinePreview('   ')).toBe('')
  })

  it('systemLabel：拆出「[标签]」+ 正文预览 —— 压缩摘要默认折叠后仍能说明发生了什么', () => {
    const base = { role: 'system' as const, id: 's', createdAt: 0 }
    // 电脑侧压缩摘要的正文形如 `[上下文摘要] ……`：前缀成为折叠头的标签
    expect(systemLabel({ ...base, text: '[上下文摘要] 之前的内容已压缩为摘要。' })).toEqual({
      tag: '上下文摘要',
      preview: '之前的内容已压缩为摘要。',
    })
    // 多行摘要：预览只取第一行（折叠头不换行）
    expect(systemLabel({ ...base, text: '[上下文摘要]\n第一行\n第二行' }).preview).toBe('第一行')
    expect(systemLabel({ ...base, text: '[上下文摘要]\n' }).preview).toBe('')
    // 没有方括号前缀：不猜语义，标签退化为「系统消息」，预览照旧
    expect(systemLabel({ ...base, text: '会话已重置' })).toEqual({
      tag: '系统消息',
      preview: '会话已重置',
    })
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
