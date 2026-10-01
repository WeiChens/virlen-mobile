/**
 * Chat —— 手机端聊天主视图（§22 重构）。
 *
 * 布局（自上而下）：
 * 1. **顶栏**：设备名 + 状态（在线 / 工作中 / 压缩中 / 已暂停）、会话标题与模型 / 上下文摘要
 *    （点标题区 = 打开会话信息面板），右上角四个 iconbtn：通讯信号（点开通讯状态面板）、
 *    新建对话、会话列表抽屉、设置（主题 / 界面大小）；
 * 2. 链路横幅 / 暂停横幅 / 待应答卡片 / 一次性提示；
 * 3. 消息区（`MessageList`）：**虚拟窗口**（只渲染视口附近的行，§34）、工具气泡带工具名、
 *    空气泡不渲染、**工具输出 / 压缩摘要默认折叠**、流式实时正文 + 思考占位；
 * 4. 输入区（工作中变「停止」）。
 *
 * 不存在「本地方便地先把会话建出来」的路径：新对话只存在于内存（`chatStore.draft`），
 * 发第一条消息时才创建会话（用户拍板，见 `NewChatPanel`）。
 *
 * ⚠️ **订阅纪律（§29）**：本页**不**订阅整个 `chatStore`。`streaming` / `toolProgress` 是
 * **每帧都在变**的切片，整店订阅等于「一个 token 重渲染整页」——高频切片一律下沉到真正
 * 消费它的叶子组件（`StreamingBubble`）。新增状态时先问一句：它会每帧变吗？
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MESSAGE_DELETE_CAPABILITY,
  MESSAGE_QUOTE_CAPABILITY,
  type MessageDTO,
  type MessageQuote,
} from 'virlen-remote'
import { useStore, useStoreSelector } from '../../lib/store'
import { chatStore } from '../../store/chat'
import { connectionStore } from '../../store/connection'
import { linkStore } from '../../store/link'
import { baseNameOf } from '../../lib/session-groups'
import {
  contextPercent,
  copyTextOf,
  deleteMessageConfirmText,
  firstLinePreview,
  menuTitlePreview,
  messageRoleLabel,
  planMessageActions,
  QUOTE_PREVIEW_MAX,
  truncateCountFrom,
  type MessageAction,
  type MessageActionItem,
} from '../../lib/messages'
import { copyText } from '../../lib/clipboard'
import { signalTone } from '../../lib/rtc-stats'
import LinkSheet from '../components/LinkSheet'
import MessageActionsSheet from '../components/MessageActionsSheet'
import MessageList, { type MessageListHandle } from '../components/MessageList'
import NewChatPanel from '../components/NewChatPanel'
import SessionDrawer from '../components/SessionDrawer'
import SessionInfoSheet from '../components/SessionInfoSheet'
import SettingsSheet from '../components/SettingsSheet'
import { IconList, IconPlus, IconSettings, IconSignal, IconSignalOff } from '../components/icons'
import './Chat.css'

/** 一次性提示的停留时长（操作类反馈：复制成功 / 已加入引用）。 */
const TOAST_MS = 2200

/** 空消息窗口的**引用稳定**回退值（选择器不得每次新建数组，见 `useStoreSelector`）。 */
const EMPTY_MESSAGES: MessageDTO[] = []

/** 菜单项列表的**引用稳定**空值（同上：不要在每次渲染里新建数组）。 */
const EMPTY_ITEMS: MessageActionItem[] = []

export default function Chat() {
  const conn = useStore(connectionStore)
  const [input, setInput] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  /** 外观设置（主题 / 界面大小）—— 与「会话信息」「通讯状态」是两层，入口也各自一个图标。 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * 长按菜单指向的消息 id（§36）——`null` = 没开菜单。
   *
   * 为什么只记 id 不记整条消息：消息会被事件刷新（`message.updated` / 定稿回填），
   * 而菜单开着的这一秒内它也可能变 —— 存 id 再现查，拿到的总是**当下**那条。
   */
  const [menuId, setMenuId] = useState<string | null>(null)
  /** 待引用的消息（发出去时一并带上，与桌面输入框的引用 chip 同一个模型）。 */
  const [pendingQuotes, setPendingQuotes] = useState<MessageQuote[]>([])
  /** 一次性提示（复制成功 / 已加入引用 / 操作失败）。 */
  const [toast, setToast] = useState<string | null>(null)
  /**
   * 消息区的把手（`MessageList`）：滚动、跟随底部、续页都在那一层。
   *
   * 为什么这里要一个命令式把手：用户**发出消息**那一刻，他的眼睛在输入框上，
   * 而列表可能还停在半截历史里 —— 必须让它落到最新一屏（旧写法是 `setAtBottom(true)`）。
   */
  const listRef = useRef<MessageListHandle | null>(null)
  /** 输入框：只用于自动增高（值仍然受控于 `input`）。 */
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  /** 提示的自动消失计时器（连续两次操作要不让前一个先把后一个抹掉）。 */
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null
      setToast(null)
    }, TOAST_MS)
  }, [])

  // 卸载时清掉挂起的计时器（否则会在已卸载的页面上 setState）
  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
    },
    [],
  )

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

  /**
   * 输入框自动增高（长到 CSS 的 `max-height` 为止）。
   *
   * 为什么不是简单加几行 `rows`：`rows` 是初始高度，不是上限，写大了就占掉半个屏幕。
   * 先归零再量 `scrollHeight`，是唯一能让它「删回去也跟着缩」的写法。
   *
   * `scrollHeight` 为 0 时直接返回：jsdom 不排版，若照写 `0px` 会把输入框压成一条线（测试环境）。
   */
  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`
  }

  const submit = () => {
    const text = input
    const quotes = pendingQuotes
    setInput('')
    setPendingQuotes([])
    // 缩回一行：否则发完一条长消息，输入框还占着好几行高度（里面却已经空了）
    if (inputRef.current) inputRef.current.style.height = ''
    // 发出即落到最新一屏（此刻用户的眼睛在输入框上，留在半截历史里会看不到自己刚发的消息）
    listRef.current?.scrollToBottom()
    // 无会话时由 store 负责「先创建再发送」（发送这一刻才创建）
    void chatStore.send(text, quotes)
  }

  /* ─────────────────── §36 长按菜单 ─────────────────── */

  /**
   * 长按某条消息（由 `MessageList` 逐行上报）。
   *
   * ⚠️ `useCallback` 是必需的（不是优化）：行组件是 `memo` 的，回调每次换引用会让
   * 列表里所有可见行白白重渲染（§29 的同一条纪律）。
   */
  const onLongPress = useCallback((id: string) => setMenuId(id), [])

  /** 菜单指向的消息 —— 现查而不是存快照，见 `menuId` 的说明。 */
  const menuMessage = menuId ? messages.find((m) => m.id === menuId) : undefined
  /*
   * 菜单里有哪些项、哪项为什么不可点：全部由纯函数决定（`planMessageActions`）。
   * 三个事实从外面喂进去：电脑端有没有这两项能力（旧电脑会静默丢引文 / 没有删消息方法）、
   * 会话是不是正在回复（电脑侧会以 E_BUSY 拒删）。
   */
  const menuItems = menuMessage
    ? planMessageActions(menuMessage, {
        canQuote: can(MESSAGE_QUOTE_CAPABILITY),
        canDelete: can(MESSAGE_DELETE_CAPABILITY),
        busy: working,
      })
    : EMPTY_ITEMS

  const removeQuote = useCallback((messageId: string) => {
    setPendingQuotes((prev) => prev.filter((q) => q.messageId !== messageId))
  }, [])

  /**
   * 选中菜单项。
   *
   * 先把菜单收起再执行：删除会弹 `confirm`，面板留在下面会压在弹框底下（桌面 `ContextMenu`
   * 也是「先关再执行」的同一条约定）。
   */
  const runMenuAction = (action: MessageAction) => {
    const message = menuMessage
    setMenuId(null)
    if (!message) return

    if (action === 'copy') {
      void copyText(copyTextOf(message)).then((ok) => {
        // 失败也要说 —— 「点了没反应」比「复制失败」难查得多（非安全上下文下 clipboard 是 undefined）
        showToast(ok ? '已复制' : '复制失败（浏览器未授权剪贴板）')
      })
      return
    }

    if (action === 'quote') {
      // 取值域由 `planMessageActions` 卡住（只有 user / assistant 会给这一项），这里只做收窄
      if (message.role !== 'user' && message.role !== 'assistant') return
      // 先把快照建好再进更新函数：闭包里的收窄会丢（TS 不会把外层收窄带进回调）
      const quote: MessageQuote = {
        messageId: message.id,
        role: message.role,
        text: message.text,
      }
      setPendingQuotes((prev) =>
        prev.some((q) => q.messageId === quote.messageId) ? prev : [...prev, quote],
      )
      showToast('已加入引用，发消息时会一并带上')
      return
    }

    // ── 删除（截断，不可逆）：先报清楚会删掉多少条 ──
    if (!currentId) return
    const count = truncateCountFrom(messages, message.id)
    if (count <= 0) return
    if (!window.confirm(deleteMessageConfirmText(count))) return
    void chatStore.deleteMessage(currentId, message.id).then((ok) => {
      if (!ok) showToast('删除失败（电脑侧拒绝）')
    })
  }

  const stop = () => {
    if (currentId) void chatStore.cancel(currentId)
  }

  const startNewChat = () => {
    chatStore.newChat()
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
            title="设置（主题 / 界面大小）"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <IconSettings />
          </button>
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
        /*
          消息区整块下沉到 `MessageList`（§34）：滚动容器、虚拟窗口、前插锚定、贴底跟随
          全在那一层；本页只给它数据 + 「加载更早一页」这个动作。

          ⚠️ `key={currentId}` 是**故意的**：换会话 = 重新挂载消息区 —— 滚动位置、
          折叠态、以及虚拟列表的内部记账（初始落点在底部的那条路径）都不该从上一个会话
          带过来；否则新会话的首帧会拿着旧会话的滚动位置算窗口（一帧白屏 / 错位）。
        */
        <MessageList
          key={currentId}
          ref={listRef}
          sessionId={currentId}
          messages={messages}
          working={working}
          paused={paused}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          loadingMessages={loadingMessages}
          error={error}
          cards={cards}
          onLoadOlder={() => void chatStore.loadOlder()}
          onLongPress={onLongPress}
        />
      )}

      <footer className="chat__input">
        {/* 待引用（§36）：与桌面输入框的引用 chip 同一个模型——发出去之前看得见、删得掉 */}
        {pendingQuotes.length > 0 && (
          <div className="chat__quotes">
            {pendingQuotes.map((quote) => (
              <div className="quote-chip" key={quote.messageId}>
                <span className="quote-chip__who">{messageRoleLabel(quote.role)}</span>
                <span className="quote-chip__text">
                  {firstLinePreview(quote.text, QUOTE_PREVIEW_MAX)}
                </span>
                <button
                  type="button"
                  className="quote-chip__remove"
                  aria-label="移除引用"
                  onClick={() => removeQuote(quote.messageId)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="chat__input-row">
          <textarea
            className="chat__textarea"
            ref={inputRef}
            rows={1}
            placeholder={currentId ? '发消息给 Agent…' : '发消息即创建新会话…'}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              autoGrow(e.target)
            }}
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
              /* 只引用不写正文也允许发（与桌面同口径：电脑侧会补「请针对引用的消息回复」） */
              disabled={(!input.trim() && pendingQuotes.length === 0) || (!currentId && !can('session.create'))}
              onClick={submit}
            >
              发送
            </button>
          )}
        </div>
      </footer>

      <SessionDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      {sheetOpen && currentId && (
        <SessionInfoSheet sessionId={currentId} onClose={() => setSheetOpen(false)} />
      )}
      {linkOpen && <LinkSheet onClose={() => setLinkOpen(false)} />}
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}

      {/* 长按菜单（§36）：只在有可展示的项时打开 —— 空面板比不开面板更让人困惑 */}
      {menuMessage && menuItems.length > 0 && (
        <MessageActionsSheet
          role={menuMessage.role}
          preview={menuTitlePreview(menuMessage)}
          items={menuItems}
          onPick={runMenuAction}
          onClose={() => setMenuId(null)}
        />
      )}

      {toast && (
        <div className="chat__toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}
