/**
 * SessionDrawer —— 右上角 iconbtn 打开的**右侧会话抽屉**（§22）。
 *
 * 取代了原先顶部那条横向 `chip` 列表：会话一多，横向滑动既看不到全貌，也无法表达
 * 「这些会话分别属于哪个 Agent / 哪个工作目录」。抽屉里按分组竖排，
 * 组内顺序与电脑侧完全一致（置顶优先 → updatedAt 倒序）。
 *
 * 抽屉只做「挑一个会话」这一件事：重命名 / 置顶 / 删除 / 模型 / 上下文都在会话信息面板里
 * （`SessionInfoSheet`）——手机屏幕上把两类操作混在一层，误触代价太大。
 */
import { useState } from 'react'
import type { SessionSummaryDTO } from 'virlen-remote'
import { useStore } from '../../lib/store'
import { chatStore } from '../../store/chat'
import { connectionStore } from '../../store/connection'
import {
  baseNameOf,
  groupNeedsAttention,
  groupSessions,
  readGroupMode,
  writeGroupMode,
  type GroupMode,
} from '../../lib/session-groups'
import { IconClose } from './icons'
import './SessionDrawer.css'

interface Props {
  open: boolean
  onClose: () => void
}

export default function SessionDrawer({ open, onClose }: Props) {
  const chat = useStore(chatStore)
  const conn = useStore(connectionStore)
  // 分组方式持久化（PWA 重开后保持选择）
  const [mode, setMode] = useState<GroupMode>(readGroupMode)
  /**
   * 分组的展开态（键 = `group.key`）。
   *
   * ⚠️ **默认全部收起**（用户要求，2026-10-01）：抽屉一打开时，会话列表可能很长，
   * 先给一张「组目录」，用户按需展开；收起态下仍有工作的 / 当前的分组会被高亮提醒
   * （`groupNeedsAttention`），不会出现「藏起来就丢信息」。
   */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  if (!open) return null

  const groups = groupSessions(chat.sessions, mode)

  const toggleGroup = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))

  const pick = (sessionId: string) => {
    void chatStore.openSession(sessionId)
    onClose()
  }

  const switchMode = (next: GroupMode) => {
    setMode(next)
    writeGroupMode(next)
  }

  const disconnect = () => {
    if (!window.confirm('断开与电脑的连接？断开后需要重新连接才能继续操作。')) return
    connectionStore.disconnect()
    onClose()
  }

  return (
    <>
      <div className="drawer__backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="会话列表">
        <header className="drawer__head">
          <span className="drawer__title">会话</span>
          <div className="drawer__modes" role="group" aria-label="分组方式">
            <button
              type="button"
              className={`drawer__mode${mode === 'agent' ? ' is-on' : ''}`}
              onClick={() => switchMode('agent')}
            >
              按 Agent
            </button>
            <button
              type="button"
              className={`drawer__mode${mode === 'workspace' ? ' is-on' : ''}`}
              onClick={() => switchMode('workspace')}
            >
              按目录
            </button>
          </div>
          <button type="button" className="drawer__close" aria-label="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        <div className="drawer__body">
          {chat.sessions.length === 0 && (
            <p className="drawer__hint">{chat.loadingSessions ? '加载会话…' : '电脑上还没有会话'}</p>
          )}
          {groups.map((group) => {
            const isOpen = expanded[group.key] === true
            // 高亮只在收起态生效：展开后内容自现，再高亮反而多余
            const alert = !isOpen && groupNeedsAttention(group, chat.currentSessionId)
            const workingCount = group.sessions.filter((s) => s.working).length
            return (
              <section key={group.key} className={`sgroup${alert ? ' sgroup--alert' : ''}`}>
                <button
                  type="button"
                  className="sgroup__head"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={isOpen}
                  title={group.label}
                >
                  <span className="sgroup__chevron" aria-hidden="true">
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span className="sgroup__label">{group.label}</span>
                  {alert && <span className="sgroup__alert-dot" aria-hidden="true" />}
                  <span className="sgroup__count">{group.sessions.length}</span>
                </button>
                {isOpen &&
                  group.sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className={`srow${session.id === chat.currentSessionId ? ' srow--active' : ''}`}
                      onClick={() => pick(session.id)}
                    >
                      <span className="srow__main">
                        <span className="srow__title">{session.title || '(无标题)'}</span>
                        <span className="srow__meta">{metaOf(session, mode)}</span>
                      </span>
                      {session.working && <span className="srow__dot" title="正在回复中" />}
                      {session.pinned && (
                        <span className="srow__pin" title="已置顶">
                          ★
                        </span>
                      )}
                    </button>
                  ))}
                {/* 收起且组内有会话在干活：给一句「几个在干活」，比一个点更明确 */}
                {!isOpen && workingCount > 0 && (
                  <p className="sgroup__hint">{workingCount} 个会话正在工作</p>
                )}
              </section>
            )
          })}
        </div>

        {/* 断开连接总能到达（新对话状态下没有会话信息面板） */}
        <footer className="drawer__foot">
          <span className="drawer__device">{conn.device?.name ?? '未知设备'}</span>
          <button type="button" className="btn btn--small btn--ghost" onClick={disconnect}>
            断开
          </button>
        </footer>
      </aside>
    </>
  )
}

/**
 * 每行的副标题。
 *
 * 刻意「显示另一个维度」：按 Agent 分组时显示工作目录，按目录分组时显示 Agent ——
 * 同一个信息不在同一行里重复两遍，屏幕小、信息密度要花在刀刃上。
 */
function metaOf(session: SessionSummaryDTO, mode: GroupMode): string {
  const parts: string[] = []
  if (mode === 'agent') {
    if (session.workspace) parts.push(baseNameOf(session.workspace))
  } else if (session.agentName) {
    parts.push(session.agentName)
  }
  if (session.modelId) parts.push(session.modelId)
  if (session.working) parts.push('工作中')
  return parts.join(' · ')
}
