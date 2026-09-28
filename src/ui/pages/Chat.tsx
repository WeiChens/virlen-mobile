/**
 * Chat —— 手机端聊天主视图（§22 重构）。
 *
 * 布局（自上而下）：
 * 1. **顶栏**：设备名 + 状态（在线 / 工作中 / 压缩中 / 已暂停）、会话标题与模型 / 上下文摘要
 *    （点标题区 = 打开会话信息面板），右上角三个 iconbtn：通讯信号（点开通讯状态面板）、
 *    新建对话、会话列表抽屉；
 * 2. 链路横幅 / 暂停横幅 / 待应答卡片 / 一次性提示；
 * 3. 消息区（工具气泡带工具名、空气泡不渲染、流式实时正文 + 思考占位）；
 * 4. 输入区（工作中变「停止」）。
 *
 * 不存在「本地方便地先把会话建出来」的路径：新对话只存在于内存（`chatStore.draft`），
 * 发第一条消息时才创建会话（用户拍板，见 `NewChatPanel`）。
 *
 * ⚠️ **订阅纪律（§29）**：本页**不**订阅整个 `chatStore`。`streaming` / `toolProgress` 是
 * **每帧都在变**的切片，整店订阅等于「一个 token 重渲染整页」——高频切片一律下沉到真正
 * 消费它的叶子组件（`StreamingBubble`）。新增状态时先问一句：它会每帧变吗？
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { MessageDTO } from 'virlen-remote'
import { useStore, useStoreSelector } from '../../lib/store'
import { chatStore } from '../../store/chat'
import { connectionStore } from '../../store/connection'
import { linkStore } from '../../store/link'
import { baseNameOf } from '../../lib/session-groups'
import { contextPercent, hasBody, pendingLabel, toolLabel, toolPreview } from '../../lib/messages'
import { signalTone } from '../../lib/rtc-stats'
import InteractionCard from '../../components/InteractionCard'
import Markdown from '../../components/Markdown'
import LinkSheet from '../components/LinkSheet'
import NewChatPanel from '../components/NewChatPanel'
import SessionDrawer from '../components/SessionDrawer'
import SessionInfoSheet from '../components/SessionInfoSheet'
import { IconList, IconPlus, IconSignal, IconSignalOff } from '../components/icons'
import './Chat.css'

/** 空消息窗口的**引用稳定**回退值（选择器不得每次新建数组，见 `useStoreSelector`）。 */
const EMPTY_MESSAGES: MessageDTO[] = []

/** 单条消息。工具消息默认折叠（正文往往是整段输出，展开会淹没对话）。 */
const MessageRow = memo(function MessageRow({ message }: { message: MessageDTO }) {
  const [open, setOpen] = useState(false)

  if (message.role === 'tool') {
    // 折叠态**只显示工具名**（用户要求，2026-10-01）：工具调用在对话流里是高频噪声，
    // 折叠时应尽可能克制 —— 只留「这一步调了什么」，预览 / 正文都要展开后才占位。
    return (
      <div className="msg msg--tool">
        <button
          type="button"
          className="msg__tool-head"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? '收起工具输出' : '展开工具输出'}
        >
          <span className="msg__tool-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          {/* 工具名由电脑侧解析（`buildToolNameIndex`），手机端不猜 */}
          <span className="msg__tool-tag">{toolLabel(message)}</span>
          {open && <span className="msg__tool-preview">{toolPreview(message)}</span>}
        </button>
        {open && <pre className="msg__tool-body">{message.text}</pre>}
      </div>
    )
  }

  if (message.role === 'system') {
    // 压缩摘要等系统消息：照常显示（用户需要知道这里发生过一次上下文压缩）
    return (
      <div className="msg msg--system">
        <div className="msg__bubble">{message.text}</div>
      </div>
    )
  }

  // ⚠️ 空正文不渲染气泡：纯工具调用轮的 assistant 正文是空串，
  //    渲染出来就是一个「什么都没有的消息」，只会让用户以为界面坏了
  if (!hasBody(message)) return null

  // 用户消息按纯文本渲染（与桌面一致）：用户输入什么就显示什么，不做 Markdown 解释
  return (
    <div className={`msg msg--${message.role}`}>
      <div className="msg__bubble">
        {message.role === 'assistant' ? <Markdown content={message.text} /> : message.text}
      </div>
    </div>
  )
})

/**
 * StreamingBubble —— 流式正文 / 等待占位，**全页唯一订阅高频切片的组件**。
 *
 * 为什么要单独一个组件（§29）：`streaming` / `toolProgress` 是**每帧都在变**的切片。
 * 留在 `Chat` 里就要求 `Chat` 订阅整个 store → 「一个 token」重渲染整个聊天页
 * （顶栏 / 消息列表 / 输入区 / 抽屉）；下沉到这里后，每帧只重渲染这一个气泡。
 *
 * `working` / `paused` 走 props：它们只在「本轮开始 / 结束」时变，不属于高频切片。
 */
function StreamingBubble({
  sessionId,
  working,
  paused,
  onGrow,
}: {
  sessionId: string
  working: boolean
  paused: boolean
  /** 正文增长时回调（跟随底部）——由本组件触发，`Chat` 不必订阅 `streaming.seq`。 */
  onGrow: () => void
}) {
  const streaming = useStoreSelector(chatStore, (s) => s.streaming[sessionId])
  const toolProgress = useStoreSelector(chatStore, (s) => s.toolProgress[sessionId])
  const seq = streaming?.seq

  useEffect(() => {
    onGrow()
  }, [seq, onGrow])

  if (streaming && hasBody(streaming)) {
    // 流式正文：电脑侧按本端声明推**增量帧**，已在 store 里拼成完整正文（§32）
    return (
      <div className="msg msg--assistant">
        <div className="msg__bubble msg__bubble--stream">
          <Markdown content={streaming.text} streaming />
          <span className="caret" />
        </div>
      </div>
    )
  }

  // 还没有正文（思考中 / 工具执行中）：给一个明确的「在动」的占位，而不是空白
  if (!working || paused) return null
  return (
    <div className="msg msg--assistant">
      <div className="msg__bubble msg__bubble--pending">
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {pendingLabel({ streaming: !!streaming, toolProgress })}
      </div>
    </div>
  )
}

export default function Chat() {
  const conn = useStore(connectionStore)
  const [input, setInput] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 前插更早消息时用于保持视口（记录「距底部距离」，渲染后还原）。 */
  const anchorRef = useRef<number | null>(null)
  /** 与 `atBottom` 同步的 ref（供 `onStreamGrow` 读取，避免把 `atBottom` 做成回调依赖）。 */
  const atBottomRef = useRef(true)

  useEffect(() => {
    void chatStore.loadSessions().then(() => {
      const snap = chatStore.getSnapshot()
      if (!snap.currentSessionId && snap.sessions[0]) {
        void chatStore.openSession(snap.sessions[0].id)
      }
    })
  }, [])

  /**
   * ⚠️ **切片订阅**（§29）：不再是 `useStore(chatStore)`（订阅整个 state）。
   *
   * 流式正文每帧都改 `state.streaming`，整店订阅等于「一个 token 重渲染整页」；
   * `streaming` / `toolProgress` 两个高频切片已下沉给 `StreamingBubble` 自己订阅。
   * 下面每个选择器都只返回 state 里**既有的引用或原始值**（铁律见 `useStoreSelector`）。
   */
  const sessions = useStoreSelector(chatStore, (s) => s.sessions)
  const currentId = useStoreSelector(chatStore, (s) => s.currentSessionId)
  const messages =
    useStoreSelector(chatStore, (s) =>
      s.currentSessionId ? s.messages[s.currentSessionId] : undefined,
    ) ?? EMPTY_MESSAGES
  const working = useStoreSelector(chatStore, (s) =>
    s.currentSessionId ? s.working[s.currentSessionId] === true : false,
  )
  const paused = useStoreSelector(chatStore, (s) =>
    s.currentSessionId ? s.paused[s.currentSessionId] === true : false,
  )
  const compacting = useStoreSelector(chatStore, (s) =>
    s.currentSessionId ? s.compacting[s.currentSessionId] === true : false,
  )
  const hasOlder = useStoreSelector(chatStore, (s) =>
    s.currentSessionId ? s.hasMoreMessages[s.currentSessionId] === true : false,
  )
  const current = useStoreSelector(chatStore, (s) =>
    s.currentSessionId ? s.sessions.find((x) => x.id === s.currentSessionId) : undefined,
  )
  const context = useStoreSelector(chatStore, (s) =>
    s.currentSessionId ? s.context[s.currentSessionId] : undefined,
  )
  const interactions = useStoreSelector(chatStore, (s) => s.interactions)
  const draft = useStoreSelector(chatStore, (s) => s.draft)
  const loadingOlder = useStoreSelector(chatStore, (s) => s.loadingOlder)
  const loadingMessages = useStoreSelector(chatStore, (s) => s.loadingMessages)
  const error = useStoreSelector(chatStore, (s) => s.error)
  const notice = useStoreSelector(chatStore, (s) => s.notice)

  /**
   * 待应答卡片：**全局的（`sessionId === ''`，终端内确认无会话信息）+ 当前会话的**。
   * 其它会话的交互不在这里显示（用户没在看那个会话）——但下面有「其它会话」横幅提示，
   * 不会出现「有个请求在等我但界面毫无提示」。
   */
  const cards = interactions.filter((i) => !i.sessionId || i.sessionId === currentId)
  const otherCards = interactions.filter((i) => i.sessionId && i.sessionId !== currentId)
  const can = (cap: string) => conn.capabilities.includes(cap)

  // `atBottom` → ref（流式气泡通过 `onStreamGrow` 读它，不把 `atBottom` 做成回调依赖）
  useEffect(() => {
    atBottomRef.current = atBottom
  }, [atBottom])

  /** 流式正文增长时跟随底部（稳定引用：气泡的 effect 依赖它）。 */
  const onStreamGrow = useCallback(() => {
    if (!atBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const statusText = compacting
    ? '压缩上下文中…'
    : working
      ? '工作中…'
      : paused
        ? '已暂停'
        : '在线'

  /*
   * 通讯信号的档位与口头描述。
   *
   * 只订阅 `path` 这个**原始值**：采样每 2 秒一跳，整店订阅（`useStore(linkStore)`）
   * 会让整页聊天跟着每 2 秒重渲染一次（与 §29 的订阅纪律同一个道理）。
   * 档位一律走 `signalTone()` —— 与通讯状态面板用的是同一份判定，免得图标与面板说法不一。
   */
  const linkPath = useStoreSelector(linkStore, (s) => s.path)
  const tone = signalTone(conn.link, linkPath)
  const signalTitle =
    tone === 'good'
      ? '通讯正常 · P2P 直连'
      : tone === 'relay'
        ? '通讯正常 · TURN 中继（较慢）'
        : tone === 'warn'
          ? '链路中断，正在尝试恢复'
          : tone === 'down'
            ? '链路已断开'
            : '通讯状态未知'

  // 顶栏第二行摘要：会话 → 模型 / 上下文；新对话 → 草稿模型 / 草稿目录
  const percent = context ? contextPercent(context.tokens, context.windowTokens) : null
  const metaParts: string[] = []
  if (currentId) {
    if (current?.modelId) metaParts.push(current.modelId)
    if (percent != null) metaParts.push(`上下文 ${percent}%`)
  } else {
    if (draft.modelId) metaParts.push(draft.modelId)
    if (draft.workspace) metaParts.push(baseNameOf(draft.workspace))
  }

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // 跟随底部：只在用户本来就在底部时自动跟随，否则会打断「翻历史」
  // （流式增长那一条由 `StreamingBubble.onGrow` 触发，此处不再依赖 `streaming.seq`）
  useEffect(() => {
    if (atBottom) scrollToBottom()
  }, [messages.length, currentId, cards.length, atBottom, working])

  // 前插更早消息后还原视口（否则内容会「跳」到新插入的位置）
  useEffect(() => {
    const el = scrollRef.current
    if (el && anchorRef.current != null) {
      el.scrollTop = el.scrollHeight - anchorRef.current
      anchorRef.current = null
    }
  }, [messages.length])

  const loadOlder = () => {
    const el = scrollRef.current
    if (el) anchorRef.current = el.scrollHeight - el.scrollTop
    void chatStore.loadOlder()
  }

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom !== atBottom) setAtBottom(nearBottom)
    // 滚到顶部附近 → 自动续页（末尾的按钮是兜底：短会话滚不动时也要能点）
    if (el.scrollTop < 60 && hasOlder && !loadingOlder) loadOlder()
  }

  const submit = () => {
    const text = input
    setInput('')
    setAtBottom(true)
    // 无会话时由 store 负责「先创建再发送」（发送这一刻才创建）
    void chatStore.send(text)
  }

  const stop = () => {
    if (currentId) void chatStore.cancel(currentId)
  }

  const startNewChat = () => {
    chatStore.newChat()
    setAtBottom(true)
    setDrawerOpen(false)
  }

  const sessionTitle = (id: string): string =>
    sessions.find((s) => s.id === id)?.title || '(无标题)'

  return (
    <div className="chat">
      <header className="chat__head">
        <button
          type="button"
          className="chat__head-main"
          disabled={!currentId}
          onClick={() => currentId && setSheetOpen(true)}
        >
          <span className="chat__device">
            <span className="chat__device-name">{conn.device?.name ?? '未知设备'}</span>
            <span className={`chat__status${working ? ' is-working' : paused ? ' is-paused' : ''}`}>
              {statusText}
            </span>
          </span>
          <span className="chat__title">{currentId ? current?.title || '(无标题)' : '新对话'}</span>
          {metaParts.length > 0 && <span className="chat__meta">{metaParts.join(' · ')}</span>}
        </button>
        <div className="chat__head-actions">
          {/*
            通讯信号**一直在**右上角（不是只在断线时才冒出来）：「现在快不快、刚才是断过」
            这类问题应该是抬眼就能看出来，而不是等到发消息超时才反向推断。
          */}
          <button
            type="button"
            className={`iconbtn iconbtn--signal iconbtn--signal-${tone}`}
            title={signalTitle}
            aria-label={signalTitle}
            onClick={() => setLinkOpen(true)}
          >
            {tone === 'down' ? <IconSignalOff /> : <IconSignal />}
          </button>
          {can('session.create') && (
            <button
              type="button"
              className="iconbtn"
              title="新对话"
              aria-label="新对话"
              onClick={startNewChat}
            >
              <IconPlus />
            </button>
          )}
          <button
            type="button"
            className="iconbtn"
            title="会话列表"
            aria-label="会话列表"
            onClick={() => setDrawerOpen(true)}
          >
            <IconList />
          </button>
        </div>
      </header>

      {conn.link !== 'open' && (
        <div className="chat__link" role="status">
          <span className="chat__link-text">
            {conn.link === 'connecting'
              ? '连接中断，正在尝试恢复…'
              : conn.reconnecting
                ? `连接已断开，正在重连（${conn.reconnecting.attempt}/${conn.reconnecting.total}）…`
                : '连接已断开'}
          </span>
          {conn.link === 'closed' && !conn.reconnecting && (
            <button
              type="button"
              className="btn btn--small"
              onClick={() => connectionStore.reconnectNow()}
            >
              重新连接
            </button>
          )}
        </div>
      )}

      {/* 暂停是「用户暂存了授权 / 提问」的结果：继续按钮必须一眼可见，不能藏在面板里 */}
      {paused && currentId && can('session.resume') && (
        <div className="chat__paused" role="status">
          <span className="chat__paused-text">会话已暂停（等待处理）</span>
          <button
            type="button"
            className="btn btn--small btn--primary"
            onClick={() => void chatStore.resume(currentId)}
          >
            继续
          </button>
        </div>
      )}

      {/*
        其它会话在等应答 —— 用户没在看那个会话，若不提示就会「会话卡在 working 而无人处理」。
      */}
      {otherCards.length > 0 && (
        <div className="chat__other-cards" role="status">
          <span className="chat__other-title">其它会话待应答 {otherCards.length} 个：</span>
          {otherCards.map((i) => (
            <button
              key={i.interactionId}
              type="button"
              className="btn btn--small"
              onClick={() => void chatStore.openSession(i.sessionId)}
            >
              {sessionTitle(i.sessionId)} · {i.kind === 'choice' ? '提问' : '授权'}
            </button>
          ))}
        </div>
      )}

      {notice && (
        <div className="chat__notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="btn btn--small btn--ghost"
            onClick={() => chatStore.clearNotice()}
          >
            知道了
          </button>
        </div>
      )}

      {!currentId ? (
        <NewChatPanel />
      ) : (
        <div className="chat__messages-wrap">
          <div className="chat__messages" ref={scrollRef} onScroll={onScroll}>
            {hasOlder && (
              <button
                type="button"
                className="chat__load-older"
                disabled={loadingOlder}
                onClick={loadOlder}
              >
                {loadingOlder ? '加载中…' : '加载更早的消息'}
              </button>
            )}
            {loadingMessages && <p className="chat__loading">加载消息…</p>}
            {!loadingMessages && messages.length === 0 && (
              <p className="chat__empty">这个会话还没有消息</p>
            )}
            {messages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
            {/* 流式气泡自己订阅高频切片（§29）：Chat 不再因「一个 token」重渲染 */}
            <StreamingBubble
              sessionId={currentId}
              working={working}
              paused={paused}
              onGrow={onStreamGrow}
            />
            {error && <p className="chat__error">{error}</p>}
            {/*
              待应答卡片**贴底**渲染：渲染在顶部时，滚在底部的用户察觉不到请求。
            */}
            {cards.length > 0 && (
              <div className="chat__cards">
                {cards.map((i) => (
                  <InteractionCard key={i.interactionId} interaction={i} />
                ))}
              </div>
            )}
          </div>
          {!atBottom && (
            <button
              type="button"
              className="chat__to-bottom"
              title="回到底部"
              onClick={() => {
                setAtBottom(true)
                scrollToBottom()
              }}
            >
              ↓
            </button>
          )}
        </div>
      )}

      <footer className="chat__input">
        <textarea
          className="chat__textarea"
          rows={1}
          placeholder={currentId ? '发消息给 Agent…' : '发消息即创建新会话…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {working && can('session.cancel') ? (
          <button type="button" className="btn btn--danger btn--small" onClick={stop}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={!input.trim() || (!currentId && !can('session.create'))}
            onClick={submit}
          >
            发送
          </button>
        )}
      </footer>

      <SessionDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      {sheetOpen && currentId && (
        <SessionInfoSheet sessionId={currentId} onClose={() => setSheetOpen(false)} />
      )}
      {linkOpen && <LinkSheet onClose={() => setLinkOpen(false)} />}
    </div>
  )
}
