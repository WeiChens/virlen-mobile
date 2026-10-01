/**
 * MessageList —— 聊天页的**消息区**：V6 倒置列表（§34）。
 *
 * ## 为什么是「V6：倒置 + 免虚拟化」（替代 `@tanstack/react-virtual` / V1 手写锚点）
 *
 * 参考实现与实测结论见 `E:/code/单项研究/react虚拟列表前向插入/docs/结论与选型.md`。
 * 核心不是「怎么补前插」，而是**从坐标系上让它不存在**：
 *
 * - 数据**倒序**（最新在前）喂进来，再把**整个滚动容器** `scaleY(-1)` 镜像一次，
 *   每个直接子节点再镜像回来保持正文正立。于是 **视觉底部 = `scrollTop` 0**；
 * - 「加载历史」= 往数组**尾部追加** → 已有元素的偏移一律不变 → **前插零补偿**
 *   （再也不用前缀和模型 / 锚点 / `ResizeObserver` 回填那一套）；
 * - 代价是「视觉底部（最新一条）长高」会让已显示内容整体上移 —— 交给 `useDriftGuard`
 *   做锚点漂移纠正（见 `inverted/stick.ts`）；
 * - **完全不虚拟化**：DOM 节点数 = 消息数，所有行**始终参与真实布局**。
 *   于是「加载更多」进来的那批旧消息**一开始就是真实高度**，不会出现「先按占位高度、
 *   下一帧再校正」的跳动。
 *   （V6 原版在此叠加了 `content-visibility: auto` 跳过视口外渲染，但没渲染过的行会被 `contain-intrinsic-size`
 *   占位成一个**非真实高度** —— 加载更多时会有一瞬间的偏差，故本端**去掉**了它。）
 *
 * ## 三条必须保住的行为
 *
 * 1. **打开会话落在最新一屏**：倒置下 `scrollTop = 0` 就是最新消息，天然落底；
 *    换会话靠 `Chat` 那层的 `key={sessionId}` **重新挂载**。
 * 2. **贴底跟随**：新消息 / 卡片 / 流式增长都跟，**不在底部则一律不打扰**（不打断翻历史）。
 * 3. **上拉续页**：倒置的**视觉顶部 = `scrollTop` 最大处**，滚到顶附近自动加载。
 *
 * ## 「加载更早」的历史包袱（三轮真机修复的沉淀，别当废注释删）
 *
 * - 续页这个动作**先取消跟随**（要更早的消息 = 在看历史）—— 内容不足一屏时各种「在底部」
 *   的判定都会误判成「该跟随」，这条闸门是最后一道保险；
 * - 倒置架构下前插本身是免费的（尾部追加），但**跟随仍必须取消**：否则前插之后
 *   任何一次尾部变化都会把正在翻历史的用户拉回底部。
 * - **续页归位用「显式锚点」，但随滚动实时重建**（2026-11 第三/四轮）：续页是**异步**的，
 *   加载前先抓「屏幕上最上面那条气泡 + 它的视口偏移」，数据插进来后按它归位；补偿方向由
 *   `restoreAnchor` 现场实测，不写死符号。
 *   ⚠️ 关键：**用户一旦滚动就重建这个锚点**（见 `pendingOlderRef` 的滚动监听）。否则异步
 *   加载这几百毫秒里用户继续上滑的那段距离，会被「归位」原样抵消 —— 真机实测一次 -77px，
 *   表现为「加载后位置被弹回去、且逐页累积」。
 *
 * ## 行模型（§35）：一行不总是一条消息
 *
 * 窗口里的「项」是**行**，行模型在 `lib/message-rows.ts`（纯函数，可单测）：
 * - **连续的工具调用合成一组** → 折叠成一行「N 次工具调用」，展开后仍是各自可再展开的卡片；
 * - **什么都渲染不出来的消息不占行**（空正文的 `user` / `assistant`）。
 *
 * ## 顶部与尾部都在滚动容器之内（倒置容器的首、尾两端）
 *
 * - **尾部**（流式气泡 / 错误 / 卡片）是倒置容器的**第一个**子节点 = 视觉**最底部**；
 * - **顶部**（续页按钮 / 「加载消息…」提示）是**最后一个**子节点 = 视觉**最顶部**，
 *   随内容一起滚动、出现在最早那条消息之上。
 *   （2026-11 真机：从「固定在滚动区之上」改到「内容里」—— 不再占一条常驻竖条，也不再因它
 *   出现/消失改变滚动容器高度。）
 *
 * ## 其它三条既有纪律
 *
 * - **尾部（流式气泡 / 错误 / 待应答卡片）不参与镜像里的行序**：它是倒置容器里的**第一个**
 *   子节点（= 视觉最底部），交互卡片里有**填到一半的回答**与高风险二次确认的勾选，被卸载
 *   就等于丢失（这里本来也不卸载，但**不要在排序里动它**）；
 * - **折叠态外提**（工具卡 / 压缩摘要展开与否按行 key 记在本组件）：状态留在行里就会
 *   「展开 → 重载 → 又收起了」；
 * - **长按（§36）**：行上挂长按手势 → 回调只报「长按了哪条消息」（`onLongPress`），
 *   菜单本身在 `Chat` 那一层。工具**组**行不挂（组是 N 条消息的折叠表示，「删**这条**」没有唯一目标）。
 *
 * ⚠️ **订阅纪律（§29）**：本组件只订阅「每帧不变」的切片；`streaming` / `toolProgress`
 * 两个高频切片留给 `StreamingBubble` 自己订阅（一个 token 只重渲染那一个气泡）。
 */
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react'
import type { InteractionDTO, MessageDTO } from 'virlen-remote'
import { useStoreSelector } from '../../lib/store'
import { chatStore } from '../../store/chat'
import {
  dedupeMessages,
  hasBody,
  pendingLabel,
  systemLabel,
  toolView,
  TOOL_OMITTED_TEXT,
  firstLinePreview,
  messageRoleLabel,
  QUOTE_PREVIEW_MAX,
} from '../../lib/messages'
import { buildRows, rendersNothing, toolGroupView, type ListRow } from '../../lib/message-rows'
import InteractionCard from '../../components/InteractionCard'
import Markdown from '../../components/Markdown'
import { IconChevronDown, IconTerminal } from './icons'
import { useLongPress } from './use-long-press'
import {
  maxScrollTop,
  captureTopAnchor,
  restoreAnchor,
  useDriftGuard,
  useStickToBottom,
  type Anchor,
} from './inverted/stick'

/**
 * 「贴底」的判定容差（px）。
 *
 * 「回到底部」按钮的出现/消失、恢复跟随的阈值都用它。太小会和指尖抖动打架，
 * 太大则「明明已经滚远了还在跟」。
 */
const BOTTOM_THRESHOLD = 80

/** 滚到离**视觉顶部**这么近（px）就自动加载更早的一页（倒置下顶部 = `scrollTop` 最大处）。 */
const START_REACHED_PX = 120

/**
 * 单条消息。
 *
 * 两类「正文很长」的气泡**默认折叠**，点头部展开：
 * - `tool`：正文往往是整段输出（`git diff` 之类），展开会淹没对话；
 * - `system`：压缩产生的**上下文摘要**是整段历史的浓缩，动辄数屏 —— 默认展开会直接把
 *   对话流冲散，于是折叠态只留「标签 + 正文开头」。
 *
 * 折叠态显示什么一律由 `lib/messages.ts` 的纯函数决定（可单测），本组件只管摆 HTML。
 * 「哪个节点是展开的」由列表持有（见文件头 §折叠态外提），所以这里是受控的。
 */
const MessageRow = memo(function MessageRow({
  message,
  open,
  onToggle,
  onLongPress,
}: {
  message: MessageDTO
  open: boolean
  onToggle: (id: string) => void
  onLongPress?: (id: string) => void
}) {
  /*
   * ⚠️ 钩子必须在所有 `return` 之前无条件调用（`rendersNothing` 那条会 return null）——
   * 它是 hooks 规则，也是「条件调用 = 渲染次数一变就崩」的那类缺陷。
   */
  const press = useLongPress(() => onLongPress?.(message.id))

  if (message.role === 'tool') {
    /*
     * 工具调用卡片（2026-10 重做）：一张卡 —— 头部（图标 + 等宽工具名 + 规模 + 旋转箭头），
     * 展开后在同一张卡里多出一条分隔线、一段可横滑的等宽正文、一行规模小字。
     * 折叠态只回答「这一步调了什么」（工具名）+「输出有多大」（行数）。
     */
    const view = toolView(message)
    return (
      <div className="msg msg--tool" {...press}>
        <div className={`tool-card${open ? ' is-open' : ''}`}>
          <button
            type="button"
            className="tool-card__head"
            onClick={() => onToggle(message.id)}
            aria-expanded={open}
            title={open ? '收起工具输出' : '展开工具输出'}
          >
            <IconTerminal className="tool-card__icon" width={16} height={16} />
            {/* 工具名由电脑侧解析（`buildToolNameIndex`），手机端不猜 */}
            {view.name ? (
              <code className="tool-card__name">{view.name}</code>
            ) : (
              <span className="tool-card__name tool-card__name--unknown">工具调用</span>
            )}
            {/* 展开后不重复规模：正文下面就有一行更全的（行数 · 字符数） */}
            {!open && view.size && (
              <span className={`tool-card__size${view.omitted ? ' tool-card__size--omitted' : ''}`}>
                {view.size}
              </span>
            )}
            <IconChevronDown className="tool-card__caret" width={15} height={15} />
          </button>
          {open && (
            <>
              {hasBody(message) ? (
                <pre className="tool-card__body">{message.text}</pre>
              ) : view.omitted ? (
                /*
                 * 被档位省略 ≠ 没有输出（§33）：说清是策略 + 什么条件下会这样 + 怎么拿回全文，
                 * 而不是摆一句「这次调用没有输出」——那是**假话**（工具有输出，只是没下发）。
                 */
                <p className="tool-card__omitted">{TOOL_OMITTED_TEXT}</p>
              ) : (
                // 空输出也要说一句：空白卡片让人以为是渲染坏了（与「空正文不渲染气泡」同一条理由）
                <p className="tool-card__empty">这次调用没有输出</p>
              )}
              {view.meta && <div className="tool-card__meta">{view.meta}</div>}
            </>
          )}
        </div>
      </div>
    )
  }

  if (message.role === 'system') {
    /*
     * 压缩摘要等系统消息：**默认折叠**（真机反馈：摘要把对话流冲散）。
     *
     * 为什么不是「干脆不显示」：用户需要知道「这里发生过一次上下文压缩」，否则上下文占用
     * 突然从 75% 掉到 10% 会显得莫名其妙。折叠态用「标签 + 正文开头」保住这条信息。
     */
    const { tag, preview } = systemLabel(message)
    return (
      <div className="msg msg--system" {...press}>
        <button
          type="button"
          className="msg__fold-head"
          onClick={() => onToggle(message.id)}
          aria-expanded={open}
          title={open ? '收起摘要' : '展开摘要'}
        >
          <span className="msg__fold-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="msg__fold-tag">{tag}</span>
          {/* 预览只在折叠态出现：展开后正文就在下面，再留一行摘要是重复 */}
          {!open && preview && <span className="msg__fold-preview">{preview}</span>}
        </button>
        {open && <div className="msg__sys-body">{message.text}</div>}
      </div>
    )
  }

  // ⚠️ 空正文不渲染气泡：纯工具调用轮的 assistant 正文是空串，
  //    渲染出来就是一个「什么都没有的消息」。判据走 `rendersNothing` —— 行模型
  //    （`buildRows`）按它决定「这行占不占位置」，两边必须同一套判据。
  if (rendersNothing(message)) return null

  /*
   * 引用条（§36）：引用**不再**展平进 `text`（见共享包 `MessageDTO.quotes`）。
   * 这里只显示**单行预览**（`firstLinePreview`）：引文快照可能是一整段 AI 回答。
   */
  const quotes = message.quotes ?? []

  // 用户消息按纯文本渲染（与桌面一致）：用户输入什么就显示什么，不做 Markdown 解释
  return (
    <div className={`msg msg--${message.role}`} {...press}>
      <div className="msg__bubble">
        {quotes.length > 0 && (
          <div className="msg__quotes">
            {quotes.map((quote) => (
              <div className="quote-bar" key={quote.messageId}>
                <span className="quote-bar__who">{messageRoleLabel(quote.role)}</span>
                <span className="quote-bar__text">
                  {firstLinePreview(quote.text, QUOTE_PREVIEW_MAX)}
                </span>
              </div>
            ))}
          </div>
        )}
        {message.role === 'assistant' ? <Markdown content={message.text} /> : message.text}
      </div>
    </div>
  )
})

/**
 * 工具调用组 —— 一段**连续**的工具调用合成一行（§35，行模型在 `lib/message-rows.ts`）。
 *
 * 折叠态只说两件事：调了几次 + 一共多少行。展开后是**各自仍可再展开**的卡片。
 *
 * §36：组行**自己**不挂长按（「删/引用**这条**」在组上没有唯一目标），但展开后每张卡片各自可长按。
 */
const ToolGroupRow = memo(function ToolGroupRow({
  row,
  open,
  folds,
  onToggle,
  onLongPress,
}: {
  row: Extract<ListRow, { kind: 'tools' }>
  open: boolean
  folds: ReadonlyMap<string, boolean>
  onToggle: (id: string) => void
  onLongPress?: (id: string) => void
}) {
  const view = toolGroupView(row.messages)
  return (
    <div className="msg msg--tool">
      <div className={`tool-group${open ? ' is-open' : ''}`}>
        <button
          type="button"
          className="tool-group__head"
          onClick={() => onToggle(row.key)}
          aria-expanded={open}
          title={open ? '收起工具调用' : '展开工具调用'}
        >
          <IconTerminal className="tool-group__icon" width={16} height={16} />
          {/* 计数文案由纯函数产出（`toolGroupView`），组件不拼文案 */}
          <span className="tool-group__label">{view.label}</span>
          {view.size && (
            <span className={`tool-group__size${view.omitted ? ' tool-group__size--omitted' : ''}`}>
              {view.size}
            </span>
          )}
          <IconChevronDown className="tool-group__caret" width={15} height={15} />
        </button>
        {open && (
          <div className="tool-group__body">
            {row.messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                open={folds.get(message.id) === true}
                onToggle={onToggle}
                onLongPress={onLongPress}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
})

/**
 * 一行：单条消息 → `MessageRow`；工具组 → `ToolGroupRow`。
 *
 * `open` 一律**由外面算好传进来** —— 组件是 `memo` 的，折叠态留在里面读（`folds.get`）
 * 就不算 props 变化，切换折叠会被 `memo` 挡掉（点了没反应）。
 */
const ListRowView = memo(function ListRowView({
  row,
  open,
  folds,
  onToggle,
  onLongPress,
}: {
  row: ListRow
  open: boolean
  folds: ReadonlyMap<string, boolean>
  onToggle: (id: string) => void
  onLongPress?: (id: string) => void
}) {
  if (row.kind === 'tools') {
    return (
      <ToolGroupRow
        row={row}
        open={open}
        folds={folds}
        onToggle={onToggle}
        onLongPress={onLongPress}
      />
    )
  }
  return <MessageRow message={row.message} open={open} onToggle={onToggle} onLongPress={onLongPress} />
})

/**
 * StreamingBubble —— 流式正文 / 等待占位，**全页唯一订阅高频切片的组件**。
 *
 * 为什么要单独一个组件（§29）：`streaming` / `toolProgress` 是**每帧都在变**的切片。
 * 留在列表里就要求列表订阅整个 store → 「一个 token」重渲染整页；下沉到这里后，
 * 每帧只重渲染这一个气泡。
 *
 * ⚠️ 跟随回调走 **layout effect**：气泡长高必须在本帧绘制**之前**完成贴底 / 纠偏，
 * 否则会看到「先长高、再跳一下」。列表本身不订阅流式切片，所以这个回调是它唯一的触发点。
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
  /** 正文增长时回调（跟随底部）——由本组件触发，列表不必订阅 `streaming.seq`。 */
  onGrow: () => void
}) {
  const streaming = useStoreSelector(chatStore, (s) => s.streaming[sessionId])
  const toolProgress = useStoreSelector(chatStore, (s) => s.toolProgress[sessionId])
  const seq = streaming?.seq

  useLayoutEffect(() => {
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

/** 首尾与空态拿到的**动态数据**（这几个组件都直接由本组件渲染，不参与行序倒置）。 */
interface ListContext {
  hasOlder: boolean
  loadingOlder: boolean
  loadingMessages: boolean
  hasMessages: boolean
  onLoadOlder: () => void
  error?: string
  cards: readonly InteractionDTO[]
  sessionId: string
  working: boolean
  paused: boolean
  onStreamGrow: () => void
}

/**
 * 列表**最顶部**（视觉顶部）：续页按钮 + 「加载消息…」提示。
 *
 * ⚠️ 在倒置容器里它是**最后一个**子节点（= 视觉最顶部，见文件头）：会随内容一起滚动，
 * 于是「加载更早」出现在最早那条消息**上面**。`scaleY(-1)` 会把直接子节点再镜像回来。
 */
const ListTop = ({ context }: { context: ListContext }) => (
  <div className="chat__list-top">
    {context.hasOlder && (
      <button
        type="button"
        className="chat__load-older"
        disabled={context.loadingOlder}
        onClick={context.onLoadOlder}
      >
        {context.loadingOlder ? '加载中…' : '加载更早的消息'}
      </button>
    )}
    {context.loadingMessages && context.hasMessages && <p className="chat__loading">加载消息…</p>}
  </div>
)

/** 空态：加载中 / 这个会话还没有消息。 */
const ListEmpty = ({ context }: { context: ListContext }) => (
  <div className="chat__list-empty">
    {context.loadingMessages ? (
      <p className="chat__loading">加载消息…</p>
    ) : (
      <p className="chat__empty">这个会话还没有消息</p>
    )}
  </div>
)

/**
 * 列表尾部：流式气泡 / 错误 / 待应答卡片。
 *
 * 在倒置容器里它是**第一个**子节点（= 视觉最底部，见文件头）：滚动不会卸载它们，
 * 所以卡片里填到一半的回答与勾选不会丢。
 */
const ListFooter = ({ context }: { context: ListContext }) => (
  <div className="chat__list-foot">
    <StreamingBubble
      sessionId={context.sessionId}
      working={context.working}
      paused={context.paused}
      onGrow={context.onStreamGrow}
    />
    {context.error && <p className="chat__error">{context.error}</p>}
    {context.cards.length > 0 && (
      <div className="chat__cards">
        {context.cards.map((i) => (
          <InteractionCard key={i.interactionId} interaction={i} />
        ))}
      </div>
    )}
  </div>
)

export interface MessageListHandle {
  /** 滚到最新一屏（发消息后用：用户此刻在输入框那边，不是在列表里）。 */
  scrollToBottom: () => void
}

interface Props {
  sessionId: string
  messages: readonly MessageDTO[]
  working: boolean
  paused: boolean
  hasOlder: boolean
  loadingOlder: boolean
  loadingMessages: boolean
  error?: string
  cards: readonly InteractionDTO[]
  /** 加载更早的一页（滚到顶自动触发，或点兜底按钮）。 */
  onLoadOlder: () => void
  /**
   * 长按某条消息（§36）—— 只报 id，菜单在 `Chat` 那层（它才拿得到输入框 / 能力集）。
   *
   * ⚠️ 调用方传**稳定引用**（`useCallback`）：行组件是 `memo` 的，每次渲染换一个新函数
   * 会让列表里所有可见行白白重渲染（§29 的订阅纪律）。
   */
  onLongPress?: (messageId: string) => void
  ref?: Ref<MessageListHandle>
}

export default function MessageList({
  sessionId,
  messages,
  working,
  paused,
  hasOlder,
  loadingOlder,
  loadingMessages,
  error,
  cards,
  onLoadOlder,
  onLongPress,
  ref,
}: Props) {
  /** 唯一的滚动容器（倒置容器 = 它自己带 `scaleY(-1)`）。 */
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  /** 把滚动容器**用 state 存一份**：贴底 / 漂移控制要拿它绑定滚动监听（ref 变化不触发重渲染）。 */
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null)
  /**
   * 「当前行数」的一个 ref 副本 —— 续页归位要靠它判断「数据到底插进来了没」
   * （`settle` 是稳定引用的回调，直接闭包 `rows.length` 会读到旧值）。
   */
  const rowsLenRef = useRef(0)

  /**
   * 「跟着最新一屏」—— 由贴底控制器提供（`inverted/stick.ts`）。
   *
   * 它与「此刻在底部」不是一回事：用户滚到半截看历史时，两者才分叉。跟随只看**用户意图**：
   * 只有用户**主动往上滚**（超过阈值）才取消跟随，滚回阈值内自动恢复。
   */
  const [following, setFollowing] = useState(true)
  const stick = useStickToBottom({
    scroller: scrollerEl,
    thresholdPx: BOTTOM_THRESHOLD,
    onFollowChange: setFollowing,
  })
  /** 漂移守卫：非跟随状态下，内容变化不得移动屏幕上已显示的内容。 */
  const drift = useDriftGuard({ scroller: scrollerEl, isFollowing: stick.following })

  /**
   * 续页（「加载更多」）的**显式锚点** —— 加载前抓、数据插进来后归位。
   *
   * 为什么在通用漂移守卫之外**还要**这一条：续页是**异步**的（要先向电脑侧拉一页），
   * 而通用守卫的基线是「随滚动不断重建」的 —— 拉取这几百毫秒里浏览器一旦有一次自己的
   * 滚动 / 布局微调，基线就被改成「已经偏了」的位置，补偿自然算不准。显式锚点把基线
   * **钉死在加载发生前的那一刻**，与中间过程无关。
   */
  const pendingOlderRef = useRef<{
    anchor: Anchor | null
    rowCount: number
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  const clearPendingOlder = useCallback(() => {
    const pending = pendingOlderRef.current
    if (pending) clearTimeout(pending.timer)
    pendingOlderRef.current = null
  }, [])

  /**
   * 续页归位后的**短时再校验**：新内容真实高度有时要到随后一两帧才收敛。
   * 用 `drift.sync()`（它随滚动重建基线）而不是钉死的锚点 —— 这样即便用户这会儿在滚，
   * 也只会「跟着当前基线」而不会把用户的手势顶回去。只跑 600ms。
   */
  const schedulePostLoadSync = useCallback(() => {
    const until = performance.now() + 600
    const step = () => {
      if (performance.now() > until) return
      const el = scrollerRef.current
      if (el && !stick.following()) drift.sync()
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [stick, drift])

  /**
   * 「内容变化后的收尾」：跟随中贴底；没贴底时纠正位置。
   *
   * 优先级：**续页显式锚点 > 通用漂移纠正** —— 续页那一帧只认「加载前抓的锚点」，
   * 绝不叠加通用漂移（两次补偿会打架，越补越偏）。
   */
  const settle = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    if (stick.stick() !== 0) return // 跟随中：已贴底，别的都别动
    const pending = pendingOlderRef.current
    if (pending && rowsLenRef.current > pending.rowCount) {
      clearPendingOlder()
      if (pending.anchor) restoreAnchor(el, pending.anchor)
      drift.reset()
      schedulePostLoadSync()
      return
    }
    drift.sync()
  }, [stick, drift, clearPendingOlder, schedulePostLoadSync])

  /** 滚到最新一屏并**强制恢复跟随**（发消息后用）。倒置下贴底 = `scrollTop` 归零。 */
  const scrollToBottom = useCallback(() => stick.forceFollow('auto'), [stick])
  useImperativeHandle(ref, () => ({ scrollToBottom }), [scrollToBottom])

  /** 流式正文增长时跟随底部（稳定引用：气泡的 layout effect 依赖它）。 */
  const onStreamGrow = useCallback(() => settle(), [settle])

  // ---------- 挂载：登记滚动容器（倒置下 `scrollTop` 0 就是最新一屏） ----------
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = 0
    setScrollerEl(el)
    return () => setScrollerEl(null)
  }, [])

  /** 容器一就绪就落到最新一屏（`scrollTop` 归零 = 视觉底部）。 */
  useLayoutEffect(() => {
    if (!scrollerEl) return
    stick.forceFollow()
  }, [scrollerEl, stick])

  // ---------- 每次提交后：跟随中贴底；非跟随时纠正漂移 ----------
  useLayoutEffect(() => {
    settle()
  })

  /**
   * 折叠态（**行 key** → 是否展开）—— 放这里才能扛住「行被重建」。
   *
   * 为什么是 `useState` 而不是 `useRef`：行组件是 `memo` 的，折叠态不是它从外面拿到的
   * props —— 引用不换，`memo` 就会把这次切换直接**挡掉**（表现：点了没反应）。
   */
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const toggleFold = useCallback((key: string) => {
    setFolds((prev) => {
      const next = new Map(prev)
      next.set(key, !(prev.get(key) === true))
      return next
    })
  }, [])

  /*
   * 行模型（§35）：列表的「项」是**行**，不是消息（连续工具调用合成组、空行不占位）。
   *
   * `dedupeMessages` 是**渲染侧的硬保证**：React 的 key 必须唯一（同 id 两条会让控制台报
   * `Encountered two children with the same key`，也会让折叠态张冠李戴）。
   */
  const rows = useMemo(() => buildRows(dedupeMessages(messages)), [messages])
  rowsLenRef.current = rows.length

  /**
   * **倒置**：最新在前喂给 DOM，配合容器的 `scaleY(-1)` 镜像显示在最底部。
   *
   * ⚠️ 这里只反**行**的顺序 —— 尾部（流式 / 卡片）是独立的一块，放在容器**第一个**子节点上
   * （见文件头），不参与这次反序。
   */
  const data = useMemo(() => rows.slice().reverse(), [rows])

  /**
   * 续页入口（滚到顶自动触发）。**必须走 ref**：滚动监听只挂一次，
   * 直接闭包会读到挂载那一刻的 `hasOlder` / `loadingOlder`。
   */
  const loadOlderRef = useRef<() => void>(() => {})
  const canLoadOlderRef = useRef(false)
  canLoadOlderRef.current = hasOlder && !loadingOlder

  /**
   * 上拉续页：倒置下**视觉顶部 = `scrollTop` 最大处**，滚到顶附近自动加载。
   * **内部去抖**：只有「从阈值外进入阈值内」才触发一次，避免一次滚动里重复请求。
   */
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let armed = true
    const onScroll = () => {
      /*
       * 用户一滚动就**重建续页锚点基线** —— 否则异步加载这几百毫秒里用户继续上滑的距离，
       * 会在数据插入时被「归位」原样抵消（真机实测一次 -77px，且逐页累积）。
       */
      const pending = pendingOlderRef.current
      if (pending) pending.anchor = captureTopAnchor(el)
      const inside = el.scrollTop >= maxScrollTop(el) - START_REACHED_PX
      if (inside && armed) {
        armed = false
        if (canLoadOlderRef.current) loadOlderRef.current()
      } else if (!inside) {
        armed = true
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  /**
   * 续页（滚到顶自动 / 头部按钮）—— 两个入口共用。
   *
   * **先取消跟随**：「要更早的消息」就是「我在看历史」（与「往上拖就取消跟随」同一条纪律）。
   * 内容不足一屏时各种「在底部」的判定都会误判成「该跟随」，这条闸门是最后一道保险。
   */
  const loadOlder = useCallback(() => {
    // 抓锚点必须发生在**数据变之前**（此刻 DOM 还是旧内容）—— 这正是「按旧锚点归位」的关键。
    clearPendingOlder()
    const el = scrollerRef.current
    const anchor = el ? captureTopAnchor(el) : null
    const timer = setTimeout(() => {
      // 兜底：万一这轮续页没有下文的（失败 / 没拉到新消息），别让锚点留到下一次无关的行增长。
      pendingOlderRef.current = null
    }, 6000)
    pendingOlderRef.current = { anchor, rowCount: rowsLenRef.current, timer }
    stick.pause()
    onLoadOlder()
  }, [onLoadOlder, stick, clearPendingOlder])
  loadOlderRef.current = loadOlder

  /**
   * 续页这一轮结束时（`loadingOlder` true→false）若锚点还没被消费，就丢弃它 ——
   * 避免它被以后某次无关的行增长「误当成」续页结果。
   */
  const prevLoadingOlderRef = useRef(loadingOlder)
  useLayoutEffect(() => {
    const was = prevLoadingOlderRef.current
    prevLoadingOlderRef.current = loadingOlder
    if (was && !loadingOlder) clearPendingOlder()
  }, [loadingOlder, clearPendingOlder])

  /** 卸载时清掉兜底定时器。 */
  useEffect(() => () => clearPendingOlder(), [clearPendingOlder])

  const context: ListContext = {
    hasOlder,
    loadingOlder,
    loadingMessages,
    hasMessages: messages.length > 0,
    onLoadOlder: loadOlder,
    error,
    cards,
    sessionId,
    working,
    paused,
    onStreamGrow,
  }

  return (
    <div className="chat__messages-wrap">
      <div ref={scrollerRef} className="chat__messages chat__messages--flipped">
        {/*
          倒置容器的第一个子节点 = 视觉**最底部**：尾部（流式气泡 / 错误 / 卡片）放这里，
          既不会被动过、也永远贴在最下面（`scaleY(-1)` 会把直接子节点再镜像回来，见 Chat.css）。
        */}
        <ListFooter context={context} />
        {data.map((row) => (
          <div className="vrow" key={row.key} data-mid={row.key}>
            <ListRowView
              row={row}
              open={folds.get(row.key) === true}
              folds={folds}
              onToggle={toggleFold}
              onLongPress={onLongPress}
            />
          </div>
        ))}
        {rows.length === 0 && <ListEmpty context={context} />}
        {/*
          倒置容器的**最后一个**子节点 = 视觉**最顶部**：「加载更早」按钮 / 「加载消息…」提示
          放这里 —— 随内容一起滚动、出现在最早那条消息之上（见 `ListTop`）。
        */}
        <ListTop context={context} />
      </div>
      {!following && (
        <button
          type="button"
          className="chat__to-bottom"
          title="回到底部"
          aria-label="回到底部"
          onClick={() => stick.forceFollow()}
        >
          <IconChevronDown width={18} height={18} />
        </button>
      )}
    </div>
  )
}
