/**
 * SessionInfoSheet —— 会话信息面板（底部抽屉，§22）。
 *
 * 承载「看 / 切」会话级配置：
 * - **模型**：看当前 + 切换（`host.session.setModel`，与桌面 model-switcher 等价）；
 * - **工作目录**：**只读** —— 用户 2026-09-28 拍板：工作目录只在新建会话时确定，
 *   已有会话不可改（否则 systemPrompt / AGENTS.md 快照会与新目录错配）；
 * - **上下文**：占用百分比 + 压缩（**不可逆**，二次确认后传 `confirm:true`）。
 *   压缩方式有两档（§22）：**AI 摘要**（要一次模型调用）与**正文压缩**（本地渲染），
 *   电脑端声明 `COMPRESS_MODE_CAPABILITY` 时各给一个按钮，否则只给一个（走电脑侧设置）；
 * - 会话写操作（重命名 / 置顶 / 删除 / 继续）。
 *
 * 为什么与抽屉分开：抽屉是「在会话之间移动」，这里是「对当前会话动手」——
 * 两者混在一层，手机上的误触代价是「删掉了会话」。
 *
 * ⚠️ **在途纪律**：面板里除了「工作目录」（只读）以外，每一个按钮点到电脑侧后都要等一个
 * 返回值（重命名 / 置顶 / 删除 / 继续 / 压缩 / 切模型）。这些动作都收口到 `usePending`：
 * 各自转圈（**慢才显示**）+ 置灰，且**同时只允许一个在途** —— 并发的写操作会互相踩
 * （最吓人的是「重命名 + 删除」同时在飞），而手机上「点了没反应」与「卡死」长得一模一样。
 */
import { useEffect, useState } from 'react'
import { COMPRESS_MIN_RATIO, COMPRESS_MODE_CAPABILITY, FILE_BROWSE_CAPABILITY } from 'virlen-remote'
import type { CompressMode } from 'virlen-remote'
import { useStore } from '../../lib/store'
import { usePending } from '../../lib/pending'
import { chatStore } from '../../store/chat'
import { connectionStore } from '../../store/connection'
import { contextPercent, formatTokens } from '../../lib/messages'
import { ModelPicker } from './ModelPicker'
import { IconClose, IconFolder } from './icons'
import './SessionInfoSheet.css'

interface Props {
  sessionId: string
  onClose: () => void
  /**
   * 「浏览文件」（§37）—— 由页面接管开关（面板不该叠在面板上，见 `Chat.tsx`）。
   *
   * 不传 = 不渲染这个入口（例如将来的其它调用方只想要配置项）。
   */
  onBrowseFiles?: () => void
}

/** 面板里正在等电脑侧受理的动作（`null` = 没有在途）。 */
type ActionKey =
  | 'resume'
  | 'rename'
  | 'pin'
  | 'delete'
  /** 旧电脑端那个笼统的入口（不传方式）。 */
  | 'compress'
  | 'compress-ai'
  | 'compress-raw'
  | 'model'

/**
 * 两个压缩入口（顺序 = 面板里的顺序 = 桌面 token 环菜单的顺序）。
 *
 * 为什么要**两个按钮**而不是一个「压缩」+ 一行方式选择：压缩本身就是不可逆的破坏性操作，
 * 已经有一次二次确认；再叠一层选择器就是「点三下才生效」。
 * 为什么把方式写进 `key` 而不是共用一个 `'compress'`：两个按钮要能分开转圈（见 `spinningKey`）。
 */
const COMPRESS_ACTIONS: ReadonlyArray<{ key: ActionKey; mode: CompressMode; label: string }> = [
  { key: 'compress-ai', mode: 'ai', label: 'AI 摘要压缩' },
  { key: 'compress-raw', mode: 'raw', label: '正文压缩' },
]

export default function SessionInfoSheet({ sessionId, onClose, onBrowseFiles }: Props) {
  const chat = useStore(chatStore)
  const conn = useStore(connectionStore)
  const [pickingModel, setPickingModel] = useState(false)
  /**
   * 面板里所有「改了电脑侧的事」的动作共用一个在途态（见文件头「在途纪律」）。
   *
   * `busy` 立刻为真（置灰 + 挡住同一时间的第二个动作），`pending` 慢才为真（转圈 /「切换中…」）
   * —— 两把尺子为什么必须分开，见 `lib/pending.ts` 的文件头。
   *
   * ⚠️ 这些 store 方法**自己吞错误**（失败只置一条 `error` 提示，不会 reject），所以
   * 「Promise 结束」= 「电脑侧已受理或已明确拒绝」—— 两种情形下都不该把面板僵在半空，
   * 错误条会把原因说清楚。
   */
  const { pending, busy, run: runAction } = usePending<ActionKey>()
  /**
   * 本次发起压缩用的方式（`null` = 本面板还没发起过）。
   *
   * 只用于「哪一颗按钮在转圈 / 说『正在压缩…』」（见 `spinningKey`）——
   * 压缩的真实进度仍以电脑侧推来的 `compacting` 为准，本字段不参与任何判定。
   */
  const [sentMode, setSentMode] = useState<CompressMode | null>(null)

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
    runAction('rename', () => chatStore.renameSession(session.id, next))
  }

  const remove = () => {
    if (!window.confirm(`删除会话「${session.title || '(无标题)'}」？此操作不可恢复。`)) return
    runAction('delete', () => chatStore.deleteSession(session.id), onClose)
  }

  /**
   * 压缩（两种方式各一个入口）。
   *
   * 确认文案只回答「会发生什么 + 不可撤销」；不去解释「哪种要花钱」—— 弹窗里多两句
   * 只会让人不读就点确定（方式的差别写在两个按钮的名字上）。
   *
   * `mode` 为 `undefined` = 本机不传方式（旧电脑端），由电脑侧设置决定 —— 与改动前同形。
   */
  const compress = (key: ActionKey, label: string, mode?: CompressMode) => {
    if (!window.confirm(`${label}会替换当前整段历史，且不可撤销。继续？`)) return
    setSentMode(mode ?? null)
    runAction(key, () => chatStore.compressContext(session.id, mode))
  }

  /*
   * 该在**哪一颗**按钮上转圈。
   *
   * `pending` 是 RPC 在途（慢才显示），`compacting` 是电脑侧受理后推来的运行时标志 ——
   * 后者没有「是谁发起的」这个信息，所以用 `sentMode` 补上；否则两个按钮会同时转圈，
   * 看起来像压了两次。
   */
  const spinningKey: ActionKey | null = compacting
    ? (COMPRESS_ACTIONS.find((a) => a.mode === sentMode)?.key ?? null)
    : pending

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
                disabled={busy}
                aria-busy={busy}
                onClick={() => runAction('resume', () => chatStore.resume(session.id))}
              >
                {pending === 'resume' && (
                  <span className="spinner spinner--sm spinner--on-fill" aria-hidden="true" />
                )}
                继续
              </button>
            )}
            {can('session.rename') && (
              <button
                type="button"
                className="btn btn--small btn--ghost"
                disabled={busy}
                aria-busy={busy}
                onClick={rename}
              >
                {pending === 'rename' && <span className="spinner spinner--sm" aria-hidden="true" />}
                重命名
              </button>
            )}
            {can('session.pin') && (
              <button
                type="button"
                className="btn btn--small btn--ghost"
                disabled={busy}
                aria-busy={busy}
                onClick={() => runAction('pin', () => chatStore.setPinned(session.id, !session.pinned))}
              >
                {pending === 'pin' && <span className="spinner spinner--sm" aria-hidden="true" />}
                {session.pinned ? '取消置顶' : '置顶'}
              </button>
            )}
            {can('session.delete') && (
              <button
                type="button"
                className="btn btn--small btn--danger"
                disabled={busy}
                aria-busy={busy}
                onClick={remove}
              >
                {pending === 'delete' && (
                  <span className="spinner spinner--sm spinner--on-fill" aria-hidden="true" />
                )}
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
              /* 切换在途时也置灰：此刻再点开候选列表只会看到一个正在变的旧值 */
              disabled={!can('session.model') || busy}
              aria-busy={busy}
              onClick={() => setPickingModel((v) => !v)}
            >
              <span className="sheet__row-label">
                {session.modelId || '（未设置模型）'}
                {session.providerName && <span className="sheet__row-sub">{session.providerName}</span>}
              </span>
              {pending === 'model' ? (
                <span className="sheet__row-hint sheet__row-hint--busy">
                  <span className="spinner spinner--sm" aria-hidden="true" />
                  切换中…
                </span>
              ) : (
                can('session.model') && (
                  <span className="sheet__row-hint">{pickingModel ? '收起' : '切换'}</span>
                )
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
                  /*
                   * 先收起候选列表再等：列表留着下一帧就会被一个已经变了的选中项打脸，
                   * 而「切换中…」转在**模型那一行**上（它才是用户看的结果）。
                   */
                  setPickingModel(false)
                  runAction('model', () => chatStore.setModel(providerConfigId, modelId))
                }}
              />
            )}
          </section>

          {/* ── 工作目录（只读；但可以**进去看**）── */}
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
            {/*
              只读不等于看不见：能进去浏览 / 下载 / 上传（§37）。
              入口放在工作目录这一行下面 —— 用户的直觉就是「从这个目录进去看」，
              而不是到顶栏找一个没写名字的文件夹图标。
              ⚠️ 能力门槛：旧电脑端没有 `file.browse` 时连入口都不出现（§3.5）
            */}
            {onBrowseFiles && session.workspace && can(FILE_BROWSE_CAPABILITY) && (
              <button type="button" className="btn btn--small" onClick={onBrowseFiles}>
                <IconFolder />
                浏览文件
              </button>
            )}
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
                {can('session.compress') &&
                  (can(COMPRESS_MODE_CAPABILITY) ? (
                    <div className="sheet__actions">
                      {COMPRESS_ACTIONS.map(({ key, mode, label }) => (
                        <button
                          key={key}
                          type="button"
                          className="btn btn--small"
                          disabled={!compressible || compacting || working || busy}
                          aria-busy={busy || compacting}
                          onClick={() => compress(key, label, mode)}
                        >
                          {spinningKey === key && (
                            <span className="spinner spinner--sm" aria-hidden="true" />
                          )}
                          {compacting && spinningKey === key ? '正在压缩…' : label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    /*
                     * 旧电脑端（没声明 `COMPRESS_MODE_CAPABILITY`）：**只给一个按钮**且不传 `mode`
                     * —— 它会把 `mode` 静默丢掉、照自己的设置压（让用户以为选了方式而实际没生效，
                     * 比「没得选」糟得多）。
                     */
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={!compressible || compacting || working || busy}
                      aria-busy={busy || compacting}
                      onClick={() => compress('compress', '压缩上下文')}
                    >
                      {pending === 'compress' || compacting ? (
                        <span className="spinner spinner--sm" aria-hidden="true" />
                      ) : null}
                      {compacting ? '正在压缩…' : '压缩上下文'}
                    </button>
                  ))}
                <p className="sheet__hint">
                  {compacting
                    ? '电脑侧正在压缩，完成后消息列表会自动刷新。'
                    : working
                      ? '正在回复中，结束后才能压缩。'
                      : compressible
                        ? can(COMPRESS_MODE_CAPABILITY)
                          ? '两种方式都会把整段历史换成一条压缩结果，且不可撤销。'
                          : '本机不传方式（旧电脑端）：走电脑端设置里的那一档，不可撤销。'
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
