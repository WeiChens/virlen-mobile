/**
 * MessageList —— 聊天页的**消息区**：虚拟窗口（`@tanstack/react-virtual`）+ 消息行渲染（§34）。
 *
 * 从 `Chat.tsx` 里抽出来，理由是这一块自成一个关注点：**滚动**（落底 / 跟随 / 续页兜底）
 * + **窗口**（只渲染视口附近的行）+ 行形态，与顶栏 / 横幅 / 输入区没有交集。
 * 样式仍在 `Chat.css`（`css-cascade.test.ts` 依赖跨文件的选择器权重顺序，拆文件会动级联顺序）。
 *
 * ## 为什么是 `@tanstack/react-virtual`（2026-11 迁移，替代 `react-virtuoso`）
 *
 * 三件真机缺陷都指向同一个机制：**前插补偿不可控**。旧库的补偿是「按**估算高度**调
 * `scrollBy`」，而本列表行高方差极大（短消息 / 整屏 Markdown / 展开后的工具卡），前插进来
 * 的那一页又大多在渲染窗口外、来不及测量 —— 估算一偏，视口就被顶走；后来我们自己在外面补的
 * 「量视口顶行 + `scrollToIndex` 对位」又会和库里那笔 `scrollBy` **互相打架**，表现为
 * 「要么跳最上面、要么跳最下面」。
 *
 * 换到 `@tanstack/react-virtual` 之后，这件事由库的 **`anchorTo: 'end'`** 承担，
 * 而且全链路可读（已在 `node_modules/@tanstack/virtual-core@3.17.11/src/index.ts` 逐段核对）：
 * - `getItemKey`：测量缓存与锚点都按**稳定 key** 记账（前插改下标不改 key）；
 * - 边缘变化（前插 / 截断）时捕「当前视口顶那一项 + 它被滚掉了多少」，在新布局里按 key
 *   找回同一条，**在渲染期就把 `scrollOffset` 折过去**（这一帧算出来的窗口就是对的），
 *   再在 layout effect 里把 `scrollTop` 写进 DOM —— 浏览器绘制前就位，没有中间帧；
 * - 未测量的新项按 `estimateSize` 记账；它们真被测量到时，库按「项顶在视口上方 → 补偿差额」
 *   把视口钉住（估算 → 测量 → 纠偏这条链是库自己走的，不会和我们打架）；
 * - `followOnAppend`：**贴底时**追加 → layout effect 里落到新底部（同样没有中间帧），
 *   不贴底时库不动手（`isAtEnd`），我们自己的 `sticky` 闸门再兜一层。
 *
 * ## ⚠️ 降级通道（**不能删**）
 *
 * 库需要**真实布局**：jsdom / 隐藏容器里 `clientHeight` / `offsetHeight` 全是 0
 * （jsdom 也没有 `ResizeObserver`），量不到尺寸时它一条都不渲染。所以量不到布局时
 * **退回纯列表**（普通流渲染全部行）：
 * - 这是产品约束：虚拟化只是显示优化，**消息不能凭空消失**（隐藏容器 / 旧浏览器 / 测试环境）；
 * - 也是既有组件级用例（`chat-bubble-fold` / `chat-tool-card` 等）能继续跑的前提。
 *
 * 降级路径不带滚动行为（容器不可见时本就滚不动），只保留头部那个「加载更早的消息」按钮。
 *
 * ## 三条必须保住的行为
 *
 * 1. **打开会话落在最新一屏**：`initialOffset` 给一个远大于内容总高的哨兵值（浏览器会把
 *    `scrollTop` 夹到底部）→ 第一帧就在底部；外加挂载时的 `scrollToEnd()` 兜底。
 *    换会话靠 `Chat` 那层的 `key={sessionId}` **重新挂载**（旧滚动状态不带到新会话）。
 * 2. **贴底跟随**：新消息 / 卡片 / 流式增长都跟，**不在底部则一律不打扰**（不打断翻历史）
 *    —— 触发条件是**尾部签名**（`tailSignature`），不是消息条数（见下一节）。
 * 3. **上拉续页**：滚到顶附近自动加载（我们自己的滚动监听），**不把用户正在看的那一行顶走**
 *    （库的 `anchorTo` 负责），也不把视图甩到底部。
 *
 * ## 「加载更早」的历史包袱（两轮真机修复的沉淀，别当废注释删）
 *
 * 前插会让 `rows.length` / `messages.length` 都变 —— **不能让任何跟随逻辑拿它们当触发条件**：
 * - 跟随看的是**尾部签名**（前插只动头部 → 签名不变）；曾经用 `messages.length`，
 *   于是「点加载更早 → 视图一瞬间切到最下面」；
 * - `scrollToBottom` 的**引用必须稳定**（它挂在「会话落底」的 layout effect 的依赖里，
 *   引用随数据变 = 每次前插都重跑一遍落底 + 把跟随摆回 true）；
 * - 「续页」这个动作**先取消跟随**（要更早的消息 = 在看历史）—— 内容不足一屏时各种
 *   「在底部」的判定都会误判成「该跟随」，这条闸门是最后一道保险。
 *
 * ## 行模型（§35）：一行不总是一条消息
 *
 * 库里的「项」是**行**，行模型在 `lib/message-rows.ts`（纯函数，可单测）：
 * - **连续的工具调用合成一组**（真机反馈：一路 `read_file` / `grep` 把对话流刷屏）→ 折叠成一行
 *   「N 次工具调用」，展开后仍是各自可再展开的卡片；
 * - **什么都渲染不出来的消息不占行**（空正文的 `user` / `assistant`）—— 它也是「连续」的判据：
 *   引擎每轮都先落一条**空正文**的 assistant 消息（`llm_loop.rs`），所以 `tool → 空 → tool`
 *   是常态，按「数组里紧挨着」判合并等于不生效。
 *
 * ## 列表的「项」：**只有消息行**，头部在滚动容器之外
 *
 * ⚠️ 头部（续页按钮 / 「加载消息…」提示）**不参与虚拟化、也不在滚动流里** —— 它挂在
 * `.chat__messages-wrap` 下、滚动容器**之上**（见 `Chat.css`）。这不是排版偏好，是一个踩过的坑
 * （2026-11 真机，与 `anchorTo` 的锚点语义直接相关）：
 *
 * 库的锚点是「**视口顶那一项** + 它被滚掉了多少」（`getVirtualItemForOffset(scrollTop)`），
 * 前插后在**新**布局里按 key 找回来、把 `scrollTop` 折过去。把头部长成第 0 项时，用户滚到
 * 顶部（`scrollTop` 落在头部那段高度里）锚点就变成头部 —— 而头部**永远在 y=0**，于是补偿量
 * 恒为 0：`scrollTop` 一个字节没变，屏幕上的内容却整屏换成了刚插进来的旧消息。
 * 这正是用户报的「加载更多后 scrollTop 没变、但看到的区域变了」。
 *
 * 头部移出去之后，锚点永远是**消息行** —— 前插后「原来看着的那一条」钉在原地，新的历史
 * 安静地出现在它上方（用户要的正是这个）。附带两个好处：不需要 `scrollMargin`
 * （头部不在滚动流里，列表坐标原点就是滚动内容原点），短会话滚不动时按钮也一直可见。
 *
 * ## 其它三条既有纪律
 *
 * - **尾部（流式气泡 / 错误 / 待应答卡片）不参与虚拟化**：它是滚动内容里的**普通流**兄弟节点
 *   （排在虚拟区之后），交互卡片里有**填到一半的回答**与高风险二次确认的勾选，被卸载就等于
 *   丢失（不只是烦，还是安全问题）；
 * - **折叠态外提**（工具卡 / 压缩摘要展开与否按行 key 记在本组件）：行会被窗口卸载，
 *   状态留在行里就会「展开 → 滚出去 → 滚回来 → 又收起了」，看起来像 bug。
 * - **长按（§36）**：行上挂长按手势 → 回调只报「长按了哪条消息」（`onLongPress`），
 *   菜单本身在 `Chat` 那一层（它才拿得到输入框与能力集）。手势细节见 `use-long-press`。
 *   工具**组**行不挂：组是 N 条消息的折叠表示，「删**这条** / 引用**这条**」没有唯一目标，
 *   展开后每张卡片各自可长按（那时目标明确）。
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
import { useVirtualizer } from '@tanstack/react-virtual'
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
import {
  buildRows,
  rendersNothing,
  tailSignature,
  toolGroupView,
  type ListRow,
} from '../../lib/message-rows'
import InteractionCard from '../../components/InteractionCard'
import Markdown from '../../components/Markdown'
import { IconChevronDown, IconTerminal } from './icons'
import { useLongPress } from './use-long-press'

/**
 * 「贴底」的判定容差（px）。
 *
 * 三处共用同一套口径：本组件里「回到底部」按钮的出现/消失、恢复跟随的阈值，
 * 以及库的 `scrollEndThreshold`（`followOnAppend` 与「贴底时尺寸变化自动补偿」都吃它）。
 * 库的默认值只有 1：那点容差在手机上太苛刻（惯性滚动收尾时停在离底几像素处，
 * 就被判成「不在底部」→ 流式正文再长高时不跟随，用户会以为卡住）。
 */
const BOTTOM_THRESHOLD = 80

/** 滚到离顶部这么近（px）就自动加载更早的一页（`scrollTop` 为负的橡皮筋也算到顶）。 */
const START_REACHED_PX = 120

/**
 * 视口外**至少**多渲染的**条数**（上下各一份预算，由库按窗口尺寸折算）。
 *
 * 为什么是条数而不是像素：真机反馈过「快速甩动看到白屏」—— 而本列表里存在**很高的单行**
 * （整屏的 Markdown 长回答 / 展开后的工具卡），像素级的预渲染遇到这种行会失效（视口上下
 * 各几百像素里连一整行都装不下）。条数级兜底没有这个问题。
 */
const OVERSCAN_ITEMS = 12

/**
 * 未测量项的高度估算（px）。
 *
 * ⚠️ 它只在「还没被渲染过、量不到」时用（首帧、前插进来还停在窗口外的那一页）：
 * 一旦渲染就会被真实高度替换，库还会把差额定点补回去（见文件头）。所以这个数**不影响
 * 正确性**，只影响首帧的滚动条比例与「估算 → 测量」那一两帧的补偿量。
 *
 * 只有一档：列表里的项**全是消息行**（头部不在列表里，见文件头「列表的『项』」）。
 */
const ROW_ESTIMATE = 96

/** 未测量项的高度估算（模块级常量：库的 options 每帧都读它，不必要地新建函数没好处）。 */
const estimateRowSize = (): number => ROW_ESTIMATE

/**
 * 单条消息。
 *
 * 两类「正文很长」的气泡**默认折叠**，点头部展开：
 * - `tool`：正文往往是整段输出（`git diff` 之类），展开会淹没对话；
 * - `system`：压缩产生的**上下文摘要**是整段历史的浓缩，动辄数屏 —— 默认展开会直接把
 *   对话流冲散，于是折叠态只留「标签 + 正文开头」，仍然告诉用户「这里压缩过一次」。
 *
 * 折叠态显示什么一律由 `lib/messages.ts` 的纯函数决定（可单测），本组件只管摆 HTML。
 * 「哪个节点是展开的」由列表持有（见文件头 §折叠态外提），所以这里是受控的。
 *
 * §36：整行挂长按（菜单在 `Chat` 那一层）。长按是**整行**的手势目标而不是只限气泡 ——
 * 手机上「按准那个气泡」本来就难，行是一块更大的靶子。
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
     * 工具调用卡片（2026-10 重做）。旧版长什么样：折叠头是一个描边圆角框，里面又装一个
     * 描边的「工具 · read_file」小标签（**框里还有框**），箭头是文字符号 `▸` 且飘在框外，
     * 展开后正文是**另一个**圆角框硬拼在下面（两个圆角接不上，像两个组件叠着）。
     *
     * 现在是一张卡：头部（图标 + 等宽工具名 + 规模 + 旋转箭头）展开后在**同一张卡**里
     * 多出一条分隔线、一段可横滑的等宽正文、一行规模小字。
     *
     * 折叠态的克制程度保持不变（用户 2026-10-01 拍板）：不摆输出预览，只回答
     * 「这一步调了什么」（工具名）+「输出有多大」（行数）—— 后者不是预览，是「要不要展开」的依据。
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
     * 突然从 75% 掉到 10% 会显得莫名其妙。折叠态用「标签 + 正文开头」保住这条信息，
     * 又不占版面；要看全文再点开。
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
  //    渲染出来就是一个「什么都没有的消息」，只会让用户以为界面坏了。
  //    判据走 `rendersNothing` —— 行模型（`buildRows`）按它决定「这行占不占位置」，
  //    两边必须同一套判据，否则会出现「有内容的行被整个丢掉」（消息凭空消失）。
  if (rendersNothing(message)) return null

  /*
   * 引用条（§36）：引用**不再**展平进 `text`（见共享包 `MessageDTO.quotes`）——
   * 若两边都出，用户会看到同一段引文两遍。
   *
   * 这里只显示**单行预览**（`firstLinePreview`）：引文快照可能是一整段 AI 回答，
   * 原样铺开会把用户自己那句话挤到屏幕外；发给模型的是完整快照，与桌面一致。
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
 * 折叠态只说两件事（与单条工具卡同一条纪律：说清「调了什么 + 有多大」，不摆输出预览）：
 * 调了几次 + 一共多少行 —— 后者是「要不要展开」的依据。展开后是**各自仍可再展开**的卡片：
 * 组里可能一次有十条输出，进来就全铺开会把手机屏撑爆。
 *
 * 组内卡片由 `Chat.css` 压成「一张卡里的多行」（去掉各自的边框与圆角，靠分隔线接续）——
 * 「框里还有框」是 2026-10 重做工具卡时明确否掉的形态。
 *
 * §36：组行**自己**不挂长按（见文件头 —— 「删/引用**这条**」在组上没有唯一目标），
 * 但展开后每张卡片各自可长按，所以 `onLongPress` 要透传下去。
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
 * 留在列表里就要求列表订阅整个 store → 「一个 token」重渲染整页
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
  /** 正文增长时回调（跟随底部）——由本组件触发，列表不必订阅 `streaming.seq`。 */
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

/** 首尾与空态拿到的**动态数据**（这几个组件都直接由本组件渲染，不再经过库的插槽）。 */
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
 * 列表头部：续页兜底按钮 + 「加载消息…」提示。
 *
 * ⚠️ 它**在滚动容器之外**（见文件头「列表的『项』」）—— 于是：短会话滚不动时按钮也一直可见、
 * 任何滚动位置都能点；而且不会成为前插锚点的目标（那正是「scrollTop 没变、视口却换了一屏」的根因）。
 *
 * 常驻显示是有意的（`hasOlder` 为真时）：它只在**还有更早的消息**时出现，翻到底就消失。
 */
const ListHeader = ({ context }: { context: ListContext }) => (
  <div className="chat__list-head">
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
 * 这三块**固定渲染、不参与虚拟化**（见文件头）：滚动不会卸载它们，
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
  /**
   * 「跟着最新一屏」——**它与「此刻在底部」不是一回事**（用户滚到半截看历史时，两者才分叉）。
   *
   * 为什么不能直接拿库的「在不在底部」当跟随的闸门：正文还在长高时，滚动位置不动而内容在下方
   * 增加 —— 「离底部多远」会自己变大，据此判定会认为「不在底部」，跟随就**中途掉队**
   * （表现：回答越长，屏幕越跟不上）。所以跟随只看**用户意图**：只有用户**主动往上滚**
   * 才取消跟随，滚回阈值内自动恢复。
   */
  const [sticky, setSticky] = useState(true)
  const stickyRef = useRef(true)
  const setStickyBoth = useCallback((next: boolean) => {
    stickyRef.current = next
    setSticky(next)
  }, [])
  /**
   * 是否走虚拟化。
   *
   * 初始值按「有没有 `ResizeObserver`」定：库量尺寸要用它，jsdom / 极旧浏览器没有 → 直接走
   * 降级通道（否则是白屏）。挂载后再按容器**真实高度**复核一次（隐藏容器同样是白屏风险）。
   */
  const [virtualized, setVirtualized] = useState(() => typeof ResizeObserver !== 'undefined')
  /** 唯一的滚动容器（两条通道共用同一个元素，切换通道不会换 DOM 节点）。 */
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const virtualizedRef = useRef(virtualized)
  virtualizedRef.current = virtualized
  /**
   * 折叠态（**行 key** → 是否展开）—— 放这里才能扛住「行被虚拟窗口卸载」。
   *
   * 为什么是 `useState` 而不是 `useRef`：行组件是 `memo` 的，折叠态不是它从外面拿到的
   * props —— 引用不换，`memo` 就会把这次切换直接**挡掉**（表现：点了没反应）。
   * 每点一次复制一份 Map，可见行最多几十条，这点分配可以忽略。
   *
   * key 用 `ListRow.key`：单条消息就是消息 id，工具组是 `tools:<首条工具消息 id>`。
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
   * 行模型（§35）：虚拟化的「项」是**行**，不是消息（连续工具调用合成组、空行不占位）。
   *
   * `dedupeMessages` 是**渲染侧的硬保证**：虚拟列表的 key 必须唯一（库的锚点解析取的是
   * **第一个**匹配 key 的项 —— 一条重复就能让前插补偿算到错的位置上）。store 已在窗口入口
   * 去过一次，这里再兜一层：本组件的正确性不该依赖上游永远干净（真机已出过一次）。
   *
   * `useMemo` 不只省一次切行：行对象**稳定**了，`memo` 的行组件才拦得住重渲染
   * （`messages` 只在 store 推数据时才换引用；无重复时 `dedupeMessages` 原样返回入参）。
   */
  const rows = useMemo(() => buildRows(dedupeMessages(messages)), [messages])

  /** 项 key 的取法：库的测量缓存与 `anchorTo` 都按它记账，**前插改下标不改 key**。 */
  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows])

  /**
   * 虚拟化窗口。
   *
   * 三个关键选项的来历都在文件头：`anchorTo`（前插不跳位）、`followOnAppend`（贴底追加
   * 在绘制前落底）、`initialOffset`（打开会话第一帧就在底部）。
   */
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    enabled: virtualized,
    estimateSize: estimateRowSize,
    getItemKey,
    overscan: OVERSCAN_ITEMS,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: BOTTOM_THRESHOLD,
    /*
     * 哨兵式的大数：库把它写进 `scrollTop` 时浏览器会夹到**底部**（挂载时内容已经在了，
     * 因为布局效应在 DOM 提交之后跑）。于是「打开会话 = 最新一屏」在第一帧就成立，
     * 不用先渲染顶部再跳（那正是「闪一下会话开头」的来源）。
     *
     * ⚠️ 只在**挂载**时读一次 —— 换会话要靠 `Chat` 那层的 `key={sessionId}` 重新挂载。
     */
    initialOffset: () => Number.MAX_SAFE_INTEGER,
  })

  /**
   * 滚到最新一屏。降级路径直接写滚动位置（容器不可见时是空操作，无害）。
   *
   * ⚠️ **deps 必须稳定**：它挂在下面「会话落底」的 layout effect 依赖里 —— 引用一旦随数据变，
   * 那条 effect 就变成「每次数据变化（含前插）都落底」（真机缺陷的根因，见文件头）。
   * 这里依赖的 `virtualizer` 实例是 `useState` 造出来、整个生命周期不换的。
   */
  const scrollToBottom = useCallback(() => {
    if (virtualizedRef.current) {
      virtualizer.scrollToEnd()
      return
    }
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [virtualizer])

  useImperativeHandle(ref, () => ({ scrollToBottom }), [scrollToBottom])

  /** 流式正文增长时跟随底部（稳定引用：气泡的 effect 依赖它）。 */
  const onStreamGrow = useCallback(() => {
    if (!stickyRef.current) return
    scrollToBottom()
  }, [scrollToBottom])

  /**
   * 续页入口（滚到顶自动触发）。**必须走 ref**：滚动监听只挂一次，
   * 直接闭包会读到挂载那一刻的 `hasOlder` / `loadingOlder`。
   */
  const loadOlderRef = useRef<() => void>(() => {})
  const canLoadOlderRef = useRef(false)
  canLoadOlderRef.current = hasOlder && !loadingOlder

  /**
   * 跟踪用户的**滚动意图**（挂在自己那个滚动容器上，而不是靠库的状态）：
   * - 离底 ≤ 阈值 → 恢复跟随；
   * - 往上拖（`scrollTop` 变小）→ 取消跟随，出现「回到底部」。
   *
   * 两个判据有**先后**：内容变短时浏览器会把 `scrollTop` 夹下来（看起来也是「变小」），
   * 但那种情况人其实仍在底部 —— 所以先判「在不在底部」，再判「有没有往上拖」。
   *
   * 顺带承担**上拉续页**：真的滚到顶附近才自动加载 —— 只有滚动事件会走到这里
   * （挂载/数据变化不会），所以不会出现「一打开就把历史一页页拉下来」。
   */
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let last = el.scrollTop
    const onScroll = () => {
      const top = el.scrollTop
      const gap = el.scrollHeight - top - el.clientHeight
      if (gap <= BOTTOM_THRESHOLD) {
        if (!stickyRef.current) setStickyBoth(true)
      } else if (top < last - 1 && stickyRef.current) {
        setStickyBoth(false)
      }
      last = top
      if (top <= START_REACHED_PX && canLoadOlderRef.current) loadOlderRef.current()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [setStickyBoth])

  /*
   * 虚拟化是否可用：按**容器真实高度**复核（挂载时 + 尺寸变化时）。
   *
   * 量不到尺寸时库一条都不渲染（**不是**降级，是空白）——所以这条通道不能省：
   * 容器从隐藏变可见时要能自己切回来，所以两个方向都要看。
   */
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const measure = () => setVirtualized(el.clientHeight > 0)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(el)
    // 兜底：某些容器变化（如父级 display 切换）不一定产生 ResizeObserver 回调
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  /*
   * 打开会话 → 落在最新一屏（外加把「跟随」摆正）。
   *
   * 用 layout effect：`useEffect` 会晚一帧，表现为「先闪一下会话开头，再跳到底部」。
   * 换会话时 `Chat` 会按 `sessionId` 重新挂载本组件，所以这条实际主要在**挂载**时跑
   * （`initialOffset` 已经把第一帧放在底部，这里是第二道保险 + 摆正 `sticky`）。
   *
   * ⚠️ 依赖里的两个回调都是**引用恒定**的，所以这条 effect 只在会话真的换了时才跑 ——
   * 这正是它的语义（曾经不是：`scrollToBottom` 依赖行数，于是「加载更早的消息」也会重跑它）。
   */
  useLayoutEffect(() => {
    setStickyBoth(true)
    scrollToBottom()
  }, [sessionId, scrollToBottom, setStickyBoth])

  /**
   * 尾部签名（见 `lib/message-rows.ts`）：尾部一变 = 「有新内容到了」，该跟着落底。
   *
   * ⚠️ 触发条件**不能**用 `messages.length`：**前插**（加载更早的消息）也会让它变，
   * 正在翻历史的用户会被拽到底部（真机缺陷）。尾部签名对前插**不变** ——
   * 前插只动头部，末行的身份 / 成员数都不动。
   */
  const tail = useMemo(() => tailSignature(rows), [rows])

  // 跟随底部：只在用户**还跟着**的时候自动跟随，否则会打断「翻历史」
  // （流式增长那一条由 `StreamingBubble.onGrow` 触发，此处不再依赖 `streaming.seq`）
  useEffect(() => {
    if (sticky) scrollToBottom()
  }, [tail, sessionId, cards.length, sticky, working, scrollToBottom])

  /**
   * 续页（滚到顶自动 / 头部按钮）—— 两个入口共用。
   *
   * **先取消跟随**：「要更早的消息」就是「我在看历史」（与「往上拖就取消跟随」同一条纪律）。
   * 尤其是**内容不足一屏**时 `gap` 恒为 0 —— 各种「在底部」的判定都会把它算成真，
   * 于是前插之后又被当成「来了新内容」拽到底部（真机反馈的正是这一下）。
   */
  const loadOlder = useCallback(() => {
    setStickyBoth(false)
    onLoadOlder()
  }, [onLoadOlder, setStickyBoth])
  loadOlderRef.current = loadOlder

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

  /*
   * 降级通道：量不到布局、或这个消息会话还一条都没有时走普通流。
   *
   * 注意两条通道**共用同一个滚动容器元素**（只有 class 与子树不同）——
   * 库的 `getScrollElement` 拿到的始终是同一个节点，切换通道不会触发重新挂载。
   */
  const plain = !virtualized || rows.length === 0

  return (
    <div className="chat__messages-wrap">
      {/*
        头部在滚动容器**之外**（见文件头「列表的『项』」）：不参与虚拟化，也不会成为前插
        锚点的目标 —— 否则用户停在顶部加载更早时，锚点落在它身上（它永远在 y=0）→ 补偿为 0 →
        「scrollTop 没变、屏幕上的内容却换了一屏」。
      */}
      <ListHeader context={context} />
      <div
        ref={scrollerRef}
        className={`chat__messages${plain ? ' chat__messages--plain' : ''}`}
      >
        {plain ? (
          rows.length === 0 ? (
            <ListEmpty context={context} />
          ) : (
            rows.map((row) => (
              <div className="vrow" key={row.key}>
                <ListRowView
                  row={row}
                  open={folds.get(row.key) === true}
                  folds={folds}
                  onToggle={toggleFold}
                  onLongPress={onLongPress}
                />
              </div>
            ))
          )
        ) : (
          /*
            虚拟窗口：外层容器高度 = 总尺寸，项用 `translateY(start)` 绝对定位。
            `data-index` + `measureElement` 让库能逐项量高（行高事先未知且方差极大）；
            渲染范围只覆盖「视口 ± overscan」，其余的实现细节全在库里。
          */
          <div className="chat__list-body" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = rows[virtualItem.index]
              if (!row) return null
              return (
                <div
                  className="chat__vitem"
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <div className="vrow">
                    <ListRowView
                      row={row}
                      open={folds.get(row.key) === true}
                      folds={folds}
                      onToggle={toggleFold}
                      onLongPress={onLongPress}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <ListFooter context={context} />
      </div>
      {!sticky && (
        <button
          type="button"
          className="chat__to-bottom"
          title="回到底部"
          aria-label="回到底部"
          onClick={() => {
            setStickyBoth(true)
            scrollToBottom()
          }}
        >
          <IconChevronDown width={18} height={18} />
        </button>
      )}
    </div>
  )
}
