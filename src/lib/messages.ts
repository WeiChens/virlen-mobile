/**
 * 消息渲染的视图规则 —— **纯函数，可单测**。
 *
 * 手机端的消息渲染有三条与桌面**故意不同**的取舍（都是真机反馈的结论）：
 *
 * 1. **空正文不渲染气泡**：纯工具调用轮的 assistant 消息正文是空串（Rust 引擎
 *    `llm_round.rs` 建的 assistant 消息内容初始为空），渲染出来就是一个空气泡 ——
 *    用户看到的是「一条什么都没有的消息」，只会以为界面坏了；
 * 2. **工具气泡必须显示工具名**：`role:'tool'` 的正文只有结果文本，光看 `git status`
 *    的输出并不知道那是在干什么。工具名由电脑侧解析（`buildToolNameIndex`），
 *    解析不到时**不猜**，显示中性的「工具调用」；
 * 3. **压缩摘要等 `system` 消息照常显示、但默认折叠**：用户需要看到「这里发生过一次
 *    上下文压缩」（所以不能因为拥挤就不显示），但摘要正文是整段历史的浓缩，默认展开
 *    会把对话流冲散 —— 折叠态只留「标签 + 正文开头」，要细看再点开。
 *
 * 折叠态的文案一律由本文件的纯函数产出（组件只负责摆 HTML），这样「折叠时到底显示
 * 什么」是可单测的 —— 组件级渲染在手机端没有自动化用例（§21.4）。
 *
 * §36 起还管一件同类的事：**长按气泡弹的菜单里有哪些项、哪项为什么不可点**
 * （`planMessageActions`）。它是「能力闸门 + 角色取值域 + 会话是否在回复中」三件事的
 * 交汇点，放在组件里就只能靠人眼看 —— 而它的错法全是**静默**的
 * （旧电脑端会给一个点了没效果的「引用」；被省略的工具输出会报「已复制」）。
 */
import type { MessageDTO } from 'virlen-remote'

/** 是否有正文可渲染（空白正文一律视为没有）。 */
export function hasBody(message: Pick<MessageDTO, 'text'>): boolean {
  return message.text.trim().length > 0
}

/**
 * 正文是否被电脑侧**按传输档位省略**（§33）。
 *
 * 判据是**标记**，不是「正文为空」：空正文有两种含义 —— 真的没输出，与被策略省略了 ——
 * 而工具卡片的文案恰恰要在这两种情形下说不同的话（说反了就是编一句不成立的结论）。
 *
 * ⚠️ 按共享包的要求**不穷举标记取值**：有不认识的完整性标记也算「正文不完整」（将来增加
 * 「截断」等档位时，旧客户端仍应给诚实的提示，而不是把半截正文当成完整正文渲染）。
 */
export function isDetailOmitted(message: Pick<MessageDTO, 'detail'>): boolean {
  return message.detail != null
}

/**
 * 工具输出被档位省略时，展开后的那段说明（§33）。
 *
 * 为什么要写这么长：用户看到「已省略」的第一反应是「是不是坏了」。卡片必须同时回答三件事 ——
 * 这是**策略**（省手机流量）、**什么条件下会这样**（TURN 中继 / 通道类型未判定）、
 * 以及**怎么把全文拿回来**（切回直连后重开会话会重拉窗口，届时按完整档下发）。
 */
export const TOOL_OMITTED_TEXT =
  '工具输出已省略（精简档：TURN 中继 / 通道类型未判定时不下发工具详情，省的是手机流量）。' +
  '切回直连后重开会话可拉取全文。'

/** 折叠态预览的默认截断长度（摘要折叠头只有一行）。 */
const PREVIEW_MAX = 60

/** 第一行非空文本，超长截断（折叠态头部只有一行，换行一律丢掉）。 */
export function firstLinePreview(text: string, max = PREVIEW_MAX): string {
  const firstLine = text.split('\n').find((line) => line.trim())
  if (!firstLine) return ''
  const trimmed = firstLine.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/**
 * 工具调用气泡的**视图模型**（组件只负责摆 HTML，这里决定「显示什么」）。
 *
 * 2026-10 重做：工具气泡从「`工具 · 名字` 描边小标签 + 展开后另接一个等宽框」改成
 * **一张卡**（图标 + 等宽工具名 + 规模，展开后正文留在同一张卡里）。所以原来的
 * `toolLabel`（拼文案）/`toolPreview`（折叠态预览）不再适用 —— 折叠态按用户 2026-10-01
 * 的拍板**不显示输出预览**，只回答「这一步调了什么 + 输出有多大」。
 *
 * 仍守住原来的纪律：**工具名不猜** —— 电脑侧解析不到就 `name: null`，由组件显示中性文案。
 *
 * §33 补充：被传输档位省略的工具输出（`detail:'omitted'`）**折叠态就报「已省略」** ——
 * 不能走「没有正文 ⇒ 什么都不报」那条（用户会以为还藏着东西），也不能当成「没有输出」。
 */
export interface ToolView {
  /** 工具名（如 `read_file`）；电脑侧没解析出来时为 `null`。 */
  name: string | null
  /**
   * 折叠态右侧的短标签：正常是规模（`3 行`），被档位省略时是「已省略」，
   * 真没输出时是空串（不报「0 行」——那比承认没有输出更让人困惑）。
   */
  size: string
  /** 展开后正文底部的规模（如 `3 行 · 58 字符`）；无正文时为空串。 */
  meta: string
  /** 正文被传输档位省略（§33）——组件据此把展开后的文案从「没有输出」换成「已省略」。 */
  omitted: boolean
}

/**
 * 行数。
 *
 * **末尾空行不算**：工具输出几乎都以换行结尾，不扣掉的话每条都会多报一行，
 * 而这种「差一行」的小错会让人开始怀疑其它数字。
 */
export function countLines(text: string): number {
  const body = text.replace(/\n+$/, '')
  return body.trim() ? body.split('\n').length : 0
}

export function toolView(message: MessageDTO): ToolView {
  const omitted = isDetailOmitted(message)
  const lines = countLines(message.text)
  const name = message.toolName ?? null
  if (lines === 0) return { name, size: omitted ? '已省略' : '', meta: '', omitted }
  return {
    name,
    size: `${lines} 行`,
    // 字符数复用 token 环那套口径（`12500 → 12.5k`）：同一个页面上不该有两种缩写规则
    meta: `${lines} 行 · ${formatTokens(message.text.length)} 字符`,
    omitted,
  }
}

/**
 * 系统消息（压缩产生的**上下文摘要**）折叠态的「标签 + 预览」。
 *
 * 电脑侧写摘要时正文是 `[上下文摘要] ……`：开头的方括号前缀是它的显示约定，这里把它
 * 拆成折叠加上的小标签，剩下的当预览 —— 折叠态一眼就能看出「这里压缩过、摘要开头讲了
 * 什么」。**拿不到前缀就退化为「系统消息」，不猜正文语义**（与工具名同一条纪律）。
 */
export function systemLabel(
  message: MessageDTO,
  max = PREVIEW_MAX,
): { tag: string; preview: string } {
  const text = message.text.trim()
  const match = /^\[([^\]\n]{1,20})\]\s*/.exec(text)
  if (!match) return { tag: '系统消息', preview: firstLinePreview(text, max) }
  return { tag: match[1], preview: firstLinePreview(text.slice(match[0].length), max) }
}

/** 上下文占用百分比（`tokens` 未知时返回 null —— 未知与 0% 是两回事）。 */
export function contextPercent(tokens: number | null, windowTokens: number): number | null {
  if (tokens == null || windowTokens <= 0) return null
  return Math.round(Math.min(tokens / windowTokens, 1) * 100)
}

/** 200000 → 200k，12500 → 12.5k（与桌面 token 环同一套显示口径）。 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const k = tokens / 1000
  return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`
}

/* ─────────────────── 消息顺序（§37） ─────────────────── */

/**
 * 一条**新到的消息**该插在本地窗口的哪个位置（返回值 = 下标；`messages.length` = 追加到尾部）。
 *
 * 为什么不能无脑追加（真机缺陷的根因）：电脑侧把**两类**东西都发成同一个
 * `host.event.message.added`：
 *
 * 1. 时间线**尾部**的新消息（正常：用户发话 / AI 回复 / 工具结果）；
 * 2. **向前回补的更早历史** —— 手机端上拉续页时，电脑侧 `loadOlderMessages` 把新加载的
 *    那一页前插进它自己的窗口，而 `store-bridge` 的 diff（只按 id 判断「见过没有」）
 *    随之把这一页逐条当成「新出现的消息」发出来。
 *
 * 后者（文档里的「向前回补」）时间戳比本地最旧的一条还早：追加到尾部 = 历史跑到了最新
 * 消息后面（真机反馈的原话是「加载更早的消息，结果它们追加到了后面」）。
 *
 * 判据用 `createdAt`：两端时间戳同源（都来自电脑侧的消息数据），可比；
 * 也**与到达顺序无关** —— 无论 `message.added` 与续页 RPC 的应答谁先到，最终顺序一致
 * （先到的按时间插到位，后到的由 store 的 id 判重挡掉）。
 */
export function insertionIndexFor(
  messages: readonly Pick<MessageDTO, 'createdAt'>[],
  incoming: Pick<MessageDTO, 'createdAt'>,
): number {
  // 严格大于：时间戳相同的插到它们**之后**（同批消息的相对顺序保持稳定）
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].createdAt > incoming.createdAt) return i
  }
  return messages.length
}

/**
 * 窗口归一化：按 id 去重，保留**首次出现**的那一条与它的位置。
 *
 * 为什么必须有（2026-11 真机缺陷）：控制台报 `Encountered two children with the same key`
 * —— 消息窗口里出现了**同 id 的两条**。React 对 key 唯一是**硬要求**：重复 key 会报错，
 * 也会让折叠态（按行 key 记账）张冠李戴 —— 旧虚拟列表时代这条重复的后果正是
 * 「scrollTop 没变，但屏幕上换了一屏内容」。
 *
 * 重复从哪来（两条路都查过，只有这一条通）：
 * - 本地两条写入通道（`message.added` 按 id 判重、`loadOlder` 按 `known` 过滤）**进不来**；
 * - 能进来的只有电脑侧直接给的窗口数组（打开会话的快照 / 续页应答）—— 电脑侧
 *   `loadOlderMessagesInner` 的前插 `[...page.messages, ...既有窗口]` 没有去重，
 *   游标一旦重叠（并发 / 流式定稿插在中间），它自己的窗口里就是两份。
 *
 * 保留**先出现**的那一条：位置与内容取自同一份快照，不会出现「位置来自 A、内容来自 B」
 * 的错配（同 id 的两条本应内容一致；内容更新走 `message.updated`）。
 *
 * 无重复时**原样返回入参引用**：本函数在渲染路径上（`MessageList`）每帧都会跑，
 * 换引用会让行模型与整棵子树白白重建。返回类型写成可变数组是为此：入参与出参是同一个
 * 数组对象（只读入参不可能被调用方拿去改，故这处断言是安全的）。
 */
export function dedupeMessages<T extends { id: string }>(messages: readonly T[]): T[] {
  if (messages.length < 2) return messages as T[]
  let duplicated = false
  const seen = new Set<string>()
  const out: T[] = []
  for (const message of messages) {
    if (seen.has(message.id)) {
      duplicated = true
      continue
    }
    seen.add(message.id)
    out.push(message)
  }
  return duplicated ? out : (messages as T[])
}

/* ─────────────────── 长按菜单（§36：复制 / 引用 / 删除） ─────────────────── */

/** 长按气泡菜单里的一项动作。 */
export type MessageAction = 'copy' | 'quote' | 'delete'

/** 面板里的按钮文案（放这里而不是组件里：文案是「菜单能做什么」的一部分，必须可单测）。 */
export const MESSAGE_ACTION_LABELS: Record<MessageAction, string> = {
  copy: '复制',
  quote: '引用',
  delete: '删除',
}

/** 一项菜单（含「为什么不能点」的说明）。 */
export interface MessageActionItem {
  action: MessageAction
  /** 灰显不响应点击。 */
  disabled: boolean
  /** 不可用的原因（`disabled` 时一定有）。 */
  hint?: string
}

/** 决定菜单里有哪些项时需要的**外部事实**（都不是消息自身的属性）。 */
export interface MessageActionContext {
  /**
   * 电脑端声明了 `message.quote`。
   *
   * ⚠️ 旧电脑端不认 `SendParams.quotes`（普通字段，RPC 照样成功、引文被**静默丢掉**）——
   * 那种情况下宁可不给入口，也不能让用户以为引用了而 AI 当没看见。
   */
  canQuote: boolean
  /** 电脑端声明了 `message.delete`（ACL 权限，未声明时服务端会拒）。 */
  canDelete: boolean
  /** 会话是否正在回复中 —— 电脑侧会以 `E_BUSY` 拒绝删除（不删断正在跑的那轮）。 */
  busy: boolean
}

/** 被档位省略 / 真没正文时的说明（不能报「已复制」，那是谎话）。 */
export const COPY_OMITTED_HINT = '正文被传输档位省略（TURN 中继），本机没有可复制的文本'
export const COPY_EMPTY_HINT = '这条消息没有可复制的正文'
/** 会话正在回复中时删除不可用的原因。 */
export const DELETE_BUSY_HINT = '会话正在回复中，结束后才能删除'

/**
 * 长按某条消息时，面板里应该出现什么（**纯函数**）。
 *
 * 规则与桌面右键菜单逐条对齐；取值域收窄的地方都写明了理由：
 *
 * - `copy`：**有正文**就给（工具消息也给 —— 复制工具输出是手机上常见的诉求）。
 *   正文为空时仍列出该项，但**灰显 + 说明原因**：分开「被档位省略」与「本来就没输出」——
 *   两者都不该谎报「已复制」，但对用户解释得不一样。
 * - `quote`：只有 `user` / `assistant` 给（引用的取值域就是这两种「对话发言」，
 *   见共享包 `MessageQuote`）；桌面端同样不给工具 / 摘要「引用」项。
 * - `delete`：`tool` **不给**（工具结果与发起它的 assistant 消息是一体两面，
 *   电脑侧会以 `E_BAD_REQUEST` 拒）；会话正在回复中时列出但灰显。
 *
 * 返回**空数组** = 这条消息不值得弹面板（调用方直接不弹，而不是弹一个空面板）。
 */
export function planMessageActions(
  message: MessageDTO,
  ctx: MessageActionContext,
): MessageActionItem[] {
  const items: MessageActionItem[] = []
  const body = hasBody(message)

  // ── 复制 ──
  if (body) {
    items.push({ action: 'copy', disabled: false })
  } else {
    items.push({
      action: 'copy',
      disabled: true,
      hint: isDetailOmitted(message) ? COPY_OMITTED_HINT : COPY_EMPTY_HINT,
    })
  }

  // ── 引用 ──
  const quotable = message.role === 'user' || message.role === 'assistant'
  if (ctx.canQuote && quotable) {
    items.push(
      body
        ? { action: 'quote', disabled: false }
        : { action: 'quote', disabled: true, hint: COPY_EMPTY_HINT },
    )
  }

  // ── 删除 ──
  if (ctx.canDelete && message.role !== 'tool') {
    items.push(
      ctx.busy
        ? { action: 'delete', disabled: true, hint: DELETE_BUSY_HINT }
        : { action: 'delete', disabled: false },
    )
  }

  return items
}

/**
 * 删除二次确认的文案（**不可逆**操作的话必须说得能被核对）。
 *
 * 为什么要把条数报出来：「及其之后的所有消息」是用户无法验证的一句话 —— 他只能选择信或不信。
 * `count` 由 `truncateCountFrom` 从**本机已加载的窗口**算出（手机加载的就是会话尾部窗口，
 * 故这个数与历史里真实的条数一致）。
 */
export function deleteMessageConfirmText(count: number): string {
  if (count <= 1) return '删除这条消息？此操作不可恢复。'
  return `删除这条消息及其之后的 ${count - 1} 条（共 ${count} 条）？此操作不可恢复。`
}

/**
 * 动作面板标题里的那条预览。
 *
 * 三种情形分开说：有正文 → 正文首行；工具卡无正文 → 工具名（比“无正文”有用得多）；
 * 被档位省略 → 直说省略（否则就是一句无信息量的空白）。
 */
export function menuTitlePreview(message: MessageDTO): string {
  if (hasBody(message)) return firstLinePreview(message.text, QUOTE_PREVIEW_MAX)
  if (message.toolName) return message.toolName
  return isDetailOmitted(message) ? '（正文被省略）' : '（无正文）'
}

/**
 * 可复制的正文（去掉首尾空白）。
 *
 * ⚠️ **不含引用块** —— 与桌面右键菜单的「复制」同一条口径（它只取 `text` 块）：
 * 用户复制的应该是自己写的话，而不是自己引用的那段别人的话。
 * 我们的投影也正好把引用块排除在 `text` 之外（见共享包 `MessageDTO.quotes`），两边一致。
 */
export function copyTextOf(message: Pick<MessageDTO, 'text'>): string {
  return message.text.trim()
}

/** 引用条 / 引用 chip 的单行预览长度。 */
export const QUOTE_PREVIEW_MAX = 60

/**
 * 发送方标签（引用条、动作面板标题都用它）。
 *
 * 四个取值都是协议里既有的角色，**不猜、不兜底成「未知」**：`MessageDTO` 里有 `system`
 * （压缩摘要）与 `tool`（工具输出），它们同样可以被长按（复制 / 删除）。
 */
export function messageRoleLabel(role: MessageDTO['role']): string {
  switch (role) {
    case 'user':
      return '你'
    case 'assistant':
      return 'AI'
    case 'tool':
      return '工具'
    default:
      return '系统'
  }
}

/**
 * 「删除这条消息」会连带删掉多少条（**含它自己**）。
 *
 * 电脑侧的语义是**截断**（本条及其之后全部，见共享包 `DeleteMessageParams`），
 * 所以二次确认必须给出一个用户能核对的数 —— 「及其之后的所有消息」是一句用户无法验证的话。
 *
 * 窗口口径：手机端加载的就是会话**尾部**窗口（分页只会往前补），故「本窗口内它之后的条数」
 * 与「历史里它之后的条数」一致；找不到该消息时返回 0（调用方据此拒绝走删除流程）。
 */
export function truncateCountFrom(
  messages: readonly MessageDTO[],
  messageId: string,
): number {
  const idx = messages.findIndex((m) => m.id === messageId)
  return idx < 0 ? 0 : messages.length - idx
}

/**
 * 「工作中」占位文案 —— 优先说出**正在做什么**（§27）。
 *
 * 背景：引擎在**累积工具参数**期间不发任何事件（provider 的分片只进本地累积器），
 * 而写一个大文件（如 2000 字的 `write_file`）意味几秒到几十秒的静默。过去手机只能
 * 显示「AI 正在处理…」，用户分不清在生成还是卡死 —— 有了 `toolProgress` 就能说出
 * 「正在生成工具调用 write_file · 1.2k 字符…」。
 *
 * 拿不到工具名（或没有进度）时不猜，退化为原来的两句。
 */
export function pendingLabel(input: {
  /** 是否已有流式正文（决定退化为「正在思考…」还是「AI 正在处理…」）。 */
  streaming: boolean
  toolProgress?: { name: string; chars: number } | null
}): string {
  const tp = input.toolProgress
  if (tp && tp.name) {
    const size = tp.chars > 0 ? ` · ${formatTokens(tp.chars)} 字符` : ''
    return `正在生成工具调用 ${tp.name}${size}…`
  }
  return input.streaming ? '正在思考…' : 'AI 正在处理…'
}
