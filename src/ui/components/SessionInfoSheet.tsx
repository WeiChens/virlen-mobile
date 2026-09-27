/**
 * SessionInfoSheet —— 会话信息面板（底部抽屉，§22）。
 *
 * 承载「看 / 切」会话级配置：
 * - **模型**：看当前 + 切换（`host.session.setModel`，与桌面 model-switcher 等价）；
 * - **工作目录**：**只读** —— 用户 2026-09-28 拍板：工作目录只在新建会话时确定，
 *   已有会话不可改（否则 systemPrompt / AGENTS.md 快照会与新目录错配）；
 * - **上下文**：占用百分比 + 压缩（**不可逆**，二次确认后传 `confirm:true`）；
 * - 会话写操作（重命名 / 置顶 / 删除 / 继续）。
 *
 * 为什么与抽屉分开：抽屉是「在会话之间移动」，这里是「对当前会话动手」——
 * 两者混在一层，手机上的误触代价是「删掉了会话」。
 */
import { useEffect, useState } from 'react'
import { COMPRESS_MIN_RATIO } from 'virlen-remote'
import { useStore } from '../../lib/store'
import { chatStore } from '../../store/chat'
import { connectionStore } from '../../store/connection'
import { contextPercent, formatTokens } from '../../lib/messages'
import { ModelPicker } from './ModelPicker'
import { IconClose } from './icons'
import './SessionInfoSheet.css'

interface Props {
  sessionId: string
  onClose: () => void
}

export default function SessionInfoSheet({ sessionId, onClose }: Props) {
  const chat = useStore(chatStore)
  const conn = useStore(connectionStore)
  const [pickingModel, setPickingModel] = useState(false)

  // 模型清单按需拉取（白名单投影；已缓存则直接命中）
  useEffect(() => {
    void chatStore.loadModels()
  }, [])

  const session = chat.sessions.find((s) => s.id === sessionId)
  if (!session) return null

  const can = (cap: string) => conn.capabilities.includes(cap)
  const context = chat.context[sessionId]
  const percent = context ? contextPercent(context.tokens, context.windowTokens) : null
  const compacting = chat.compacting[sessionId] === true
  const working = chat.working[sessionId] === true
  const paused = chat.paused[sessionId] === true

  // 与电脑侧同一条判据（`COMPRESS_MIN_RATIO` 来自共享包）：不到阈值连按钮都不给
  const compressible = percent != null && percent / 100 >= COMPRESS_MIN_RATIO

  const rename = () => {
    const next = window.prompt('重命名会话', session.title || '')
    if (next === null) return
    void chatStore.renameSession(session.id, next)
  }

  const remove = () => {
    if (!window.confirm(`删除会话「${session.title || '(无标题)'}」？此操作不可恢复。`)) return
    void chatStore.deleteSession(session.id).then(onClose)
  }

  const compress = () => {
    if (!window.confirm('压缩上下文会用摘要替换当前整段历史，且不可撤销。继续？')) return
    void chatStore.compressContext(session.id)
  }

  return (
    <>
      <div className="sheet__backdrop" onClick={onClose} />
      <section className="sheet" role="dialog" aria-label="会话信息">
        <header className="sheet__head">
          <span className="sheet__title">会话信息</span>
          <button type="button" className="sheet__close" aria-label="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        <div className="sheet__body">
          <p className="sheet__session-title">{session.title || '(无标题)'}</p>

          <div className="sheet__actions">
            {paused && can('session.resume') && (
              <button
                type="button"
                className="btn btn--small btn--primary"
                onClick={() => void chatStore.resume(session.id)}
              >
                继续
              </button>
            )}
            {can('session.rename') && (
              <button type="button" className="btn btn--small btn--ghost" onClick={rename}>
                重命名
              </button>
            )}
            {can('session.pin') && (
              <button
                type="button"
                className="btn btn--small btn--ghost"
                onClick={() => void chatStore.setPinned(session.id, !session.pinned)}
              >
                {session.pinned ? '取消置顶' : '置顶'}
              </button>
            )}
            {can('session.delete') && (
              <button type="button" className="btn btn--small btn--danger" onClick={remove}>
                删除
              </button>
            )}
          </div>

          {/* ── 模型 ── */}
          <section className="sheet__block">
            <h3 className="sheet__block-title">模型</h3>
            <button
              type="button"
              className="sheet__row sheet__row--button"
              disabled={!can('session.model')}
              onClick={() => setPickingModel((v) => !v)}
            >
              <span className="sheet__row-label">
                {session.modelId || '（未设置模型）'}
                {session.providerName && <span className="sheet__row-sub">{session.providerName}</span>}
              </span>
              {can('session.model') && (
                <span className="sheet__row-hint">{pickingModel ? '收起' : '切换'}</span>
              )}
            </button>

            {pickingModel && (
              <ModelPicker
                providers={chat.models}
                loading={chat.loadingModels}
                current={{
                  providerConfigId: session.providerConfigId,
                  modelId: session.modelId,
                }}
                onPick={(providerConfigId, modelId) => {
                  void chatStore.setModel(providerConfigId, modelId)
                  setPickingModel(false)
                }}
              />
            )}
          </section>

          {/* ── 工作目录（只读）── */}
          <section className="sheet__block">
            <h3 className="sheet__block-title">工作目录</h3>
            <div className="sheet__row">
              <span className="sheet__row-label sheet__row-label--mono">
                {session.workspace || '（未设置）'}
              </span>
            </div>
            <p className="sheet__hint">
              工作目录在新建会话时确定，已有会话不可修改 —— 需要换目录请点右上角「＋」新建会话。
            </p>
          </section>

          {/* ── 上下文 ── */}
          <section className="sheet__block">
            <h3 className="sheet__block-title">上下文</h3>
            {context ? (
              <>
                <div className="sheet__row">
                  <span className="sheet__row-label">
                    {percent == null
                      ? '占用未知（电脑侧还没有用量数据）'
                      : `${percent}%　${formatTokens(context.tokens ?? 0)} / ${formatTokens(context.windowTokens)} tokens`}
                  </span>
                </div>
                <div className="sheet__bar" aria-hidden="true">
                  <span
                    className={`sheet__bar-fill${percent != null && percent >= 80 ? ' is-critical' : ''}`}
                    style={{ width: `${percent ?? 0}%` }}
                  />
                </div>
                {can('session.compress') && (
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={!compressible || compacting || working}
                    onClick={compress}
                  >
                    {compacting ? '正在压缩…' : '压缩上下文'}
                  </button>
                )}
                <p className="sheet__hint">
                  {compacting
                    ? '电脑侧正在压缩，完成后消息列表会自动刷新。'
                    : working
                      ? '正在回复中，结束后才能压缩。'
                      : compressible
                        ? '压缩会用摘要替换整段历史，不可撤销。'
                        : `占用未达到 ${Math.round(COMPRESS_MIN_RATIO * 100)}%，无需压缩。`}
                </p>
              </>
            ) : (
              <p className="sheet__hint">占用未知（电脑侧未返回）</p>
            )}
          </section>
        </div>
      </section>
    </>
  )
}
