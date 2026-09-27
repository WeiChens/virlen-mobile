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

  if (!open) return null

  const groups = groupSessions(chat.sessions, mode)

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
          {groups.map((group) => (
            <section key={group.key} className="sgroup">
              <h3 className="sgroup__title" title={group.label}>
                <span className="sgroup__label">{group.label}</span>
                <span className="sgroup__count">{group.sessions.length}</span>
              </h3>
              {group.sessions.map((session) => (
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
            </section>
          ))}
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
