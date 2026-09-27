/**
 * InteractionCard —— 手机端应答「AI 提问 / 授权」（M4）。
 *
 * 两条硬约束（见 docs/phone-control-bridge.md §16.2）：
 *  1. **高风险必须二次确认**：不能只是「再点一次允许」。必须先把**命令原文 / 影响摘要**完整展开，
 *     用户显式勾选后才可提交，且提交时带 `confirmed: true`；电脑侧会独立校验（缺标记 = 拒绝）。
 *  2. **卡片可能在应答前失效**：电脑上先处理了、或会话被取消 → 电脑侧会推 `interaction.resolved`，
 *     store 收到即移除卡片；若应答晚到，电脑侧返回 `accepted:false`，我们只提示、不报错。
 *
 * 终端内确认（`presentation === 'terminal'`）的特例：手机**只能原样放行或拒绝**（不能编辑命令）——
 * 这是设计意图（该类授权的价值在于「当面核对命令」），故卡片明确写出「将执行上面的原始命令」。
 */
import { useState } from 'react'
import type { InteractionDTO } from 'virlen-remote'
import { chatStore } from '../store/chat'
import './InteractionCard.css'

interface Props {
  interaction: InteractionDTO
}

export default function InteractionCard({ interaction }: Props) {
  const [selected, setSelected] = useState<string[]>([])
  const [reply, setReply] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)

  const isChoice = interaction.kind === 'choice'
  const isTerminal = interaction.presentation === 'terminal'
  const high = interaction.tier === 'high'
  const options = interaction.options ?? []

  const run = async (
    action: 'allow' | 'deny' | 'shelve' | 'choose',
    opts: { value?: unknown; confirmed?: boolean } = {},
  ) => {
    setBusy(true)
    try {
      await chatStore.answer(interaction.interactionId, action, opts)
    } finally {
      setBusy(false)
    }
  }

  const toggleOption = (option: string) => {
    setSelected((prev) => {
      if (interaction.multi) {
        return prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option]
      }
      return prev.includes(option) ? [] : [option]
    })
  }

  /** 允许 / 确认：高风险先走二次确认面板 */
  const primary = () => {
    if (isChoice) {
      void run('choose', { value: { selected, customReply: reply.trim() } })
      return
    }
    if (high && !confirming) {
      setConfirming(true)
      return
    }
    void run('allow', { confirmed: high ? true : undefined })
  }

  const primaryLabel = isChoice ? '提交' : isTerminal ? '原样执行' : '允许'

  return (
    <div className={`icard${high ? ' icard--high' : ''}`}>
      <div className="icard__head">
        <span className="icard__kind">
          {isChoice ? 'AI 提问' : isTerminal ? '终端内确认' : interaction.title || '授权确认'}
        </span>
        {high && <span className="icard__risk">高风险</span>}
        {!interaction.sessionId && <span className="icard__scope">会话未知</span>}
      </div>

      {isChoice && (
        <>
          <p className="icard__question">{interaction.question || '(无问题文本)'}</p>
          <div className="icard__options">
            {options.map((o) => (
              <button
                key={o}
                type="button"
                className={`icard__option${selected.includes(o) ? ' icard__option--on' : ''}`}
                onClick={() => toggleOption(o)}
              >
                {o}
              </button>
            ))}
          </div>
          {options.length === 0 && (
            <textarea
              className="icard__reply"
              rows={2}
              placeholder="输入你的回答…"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
          )}
          {options.length > 0 && (
            <textarea
              className="icard__reply"
              rows={1}
              placeholder="补充说明（可选）"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
          )}
        </>
      )}

      {!isChoice && (
        <>
          {interaction.subTitle && <p className="icard__subtitle">{interaction.subTitle}</p>}
          <pre className="icard__code">{interaction.desc || interaction.command || '(无内容)'}</pre>
          {interaction.hint && <p className="icard__hint">{interaction.hint}</p>}
          <div className="icard__meta">
            {interaction.permName && <span className="icard__perm">{interaction.permName}</span>}
            {interaction.sandboxBypass && <span className="icard__badge">不使用沙盒</span>}
            {isTerminal && <span className="icard__badge">需在电脑上编辑请用电脑</span>}
          </div>
        </>
      )}

      {confirming && high && (
        <div className="icard__confirm">
          <p className="icard__confirm-title">高风险操作，请再次确认</p>
          <pre className="icard__code icard__code--confirm">
            {interaction.desc || interaction.command || interaction.question || '(无内容)'}
          </pre>
          <label className="icard__ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>我已核对上述内容，确认放行</span>
          </label>
        </div>
      )}

      <div className="icard__actions">
        <button
          type="button"
          className="btn btn--small btn--ghost"
          disabled={busy}
          onClick={() => void run('deny')}
        >
          {/* 与桌面弹窗同形：提问是「取消」，授权是「拒绝」（电脑侧两种都落到 deny） */}
          {isChoice ? '取消' : '拒绝'}
        </button>
        {!isChoice && !isTerminal && (
          <button
            type="button"
            className="btn btn--small btn--ghost"
            disabled={busy}
            onClick={() => void run('shelve')}
          >
            暂存
          </button>
        )}
        <button
          type="button"
          className="btn btn--primary btn--small"
          disabled={busy || (high && confirming && !ack) || (isChoice && selected.length === 0 && !reply.trim())}
          onClick={primary}
        >
          {high && confirming ? '确认放行' : primaryLabel}
        </button>
      </div>
    </div>
  )
}
