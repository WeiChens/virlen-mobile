/**
 * 会话列表分组（抽屉用）—— **纯函数，可单测**。
 *
 * 两种分组方式（抽屉里可切换，选择持久化在 `localStorage`）：
 * - `agent`（默认）：按归属 Agent —— 回答「这些会话是哪个角色在干活」；
 * - `workspace`：按工作目录 —— 回答问题「这些会话在哪个项目里」。
 *
 * ⚠️ 顺序：**组与组内都保持电脑侧给的顺序**（置顶优先 → updatedAt 倒序），
 * 先出现的组排在前面，不做二次排序。手机与电脑的列表顺序必须一致，
 * 否则用户在两端会看到两套「最近用过」的顺序。
 */
import type { SessionSummaryDTO } from 'virlen-remote'

export type GroupMode = 'agent' | 'workspace'

export interface SessionGroup {
  key: string
  label: string
  sessions: SessionSummaryDTO[]
}

/** 分组方式的持久化键（PWA 重开后保持用户选择）。 */
export const GROUP_MODE_KEY = 'virlen.mobile.group-mode'

export function readGroupMode(): GroupMode {
  try {
    return localStorage.getItem(GROUP_MODE_KEY) === 'workspace' ? 'workspace' : 'agent'
  } catch {
    return 'agent'
  }
}

export function writeGroupMode(mode: GroupMode): void {
  try {
    localStorage.setItem(GROUP_MODE_KEY, mode)
  } catch {
    /* 隐私模式下写不进去：不影响本次选择 */
  }
}

export function groupSessions(
  sessions: readonly SessionSummaryDTO[],
  mode: GroupMode,
): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  for (const session of sessions) {
    const { key, label } = groupKeyOf(session, mode)
    let group = groups.get(key)
    if (!group) {
      group = { key, label, sessions: [] }
      groups.set(key, group)
    }
    group.sessions.push(session)
  }
  return [...groups.values()]
}

function groupKeyOf(
  session: SessionSummaryDTO,
  mode: GroupMode,
): { key: string; label: string } {
  if (mode === 'workspace') {
    const path = session.workspace
    return path
      ? { key: `ws:${path}`, label: path }
      : { key: 'ws:', label: '未设置工作目录' }
  }
  const id = session.agentId
  return id
    ? { key: `agent:${id}`, label: session.agentName || '未命名 Agent' }
    : { key: 'agent:', label: '默认 Agent' }
}

/** 路径末级目录名（`E:/code/virlen` → `virlen`；无分隔符时原样返回）。 */
export function baseNameOf(path: string): string {
  return path.split('/').pop() || path
}

/**
 * 折叠态是否需要「提醒」高亮（用户要求，2026-10-01）。
 *
 * 分组的实质用途是「收纳」，但收起后信息全被藏起来 —— 若组里正有会话在干活、
 * 或就是用户当前打开的会话，收起态必须还能把它「冒出来」，否则用户会以为没动静。
 *
 * 判定依据只有两条（都在 DTO 里、无需额外请求）：
 * 1. 组内**任一会话 `working`** —— 电脑上正在回复；
 * 2. 组内**含当前会话** —— 用户正盯着的那个会话。
 *
 * 只在**收起态**调用（展开时内容自现，高亮反而多余）。
 */
export function groupNeedsAttention(
  group: SessionGroup,
  currentSessionId: string | null,
): boolean {
  return group.sessions.some(
    (s) => s.working === true || (!!currentSessionId && s.id === currentSessionId),
  )
}
