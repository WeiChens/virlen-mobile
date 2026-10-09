/**
 * 消息**行模型** —— 消息数组 → 列表的「行」（§35）。
 *
 * 为什么需要中间一层：列表需要「行」是一个**稳定的记账单位**（折叠态按行的 **key** 记账），
 * 而「一条消息 = 一行」在真机上不成立，有两类
 * 消息会打破它：
 *
 * 1. **连续的工具调用**（真机反馈：一路 `read_file` / `grep` 把对话流刷屏）→ 合成**一组**
 *    （一行装 N 条），折叠起来只留一行「N 次工具调用」；
 * 2. **什么都渲染不出来的消息**（空正文的 `user` / `assistant`，见 `rendersNothing`）→
 *    不单独成行（它本来就只贡献一个 10px 的空行盒）。
 *
 * ⚠️ 第 2 条是「连续」的**判定依据**：纯工具调用轮的 assistant 正文是空串，而引擎**每一轮
 * 都先落一条 assistant 消息**（`llm_loop.rs`：拿到 tool_calls 先 append assistant，再执行工具），
 * 所以真机上 `tool → 空 assistant → tool` 是常态。按「消息数组里紧挨着」判合并，这个功能
 * 在真机上几乎不会触发；按**屏幕上看到的样子**判（中间那条空消息不打断合并）才对得上
 * 用户的「连续」（他看到的本来就只有工具卡片，中间什么都没有）。
 *
 * 组的边界就是**看得见的边界**：`user` / `assistant`（有正文）/ `system` 都会截断一段工具调用。
 *
 * 行模型是**纯函数**：可单测（`message-rows.test.ts`），组件只负责摆 HTML。
 *
 * 除了「切行」，本文件还提供 `visibleRowCount`（**行数**，不建行对象）：手机端的**分页补足**
 * 按它判「这一页到底有没有让屏幕上多出东西」（见 `store/chat.ts` 的 `MESSAGE_MIN_ROWS`）。
 * 两者共用 `rowRoleOf`，所以折叠规则改了不会只改到一半。
 *
 * ⚠️ 前插锚定**不在本文件记账**：列表用**倒置架构**（数据倒序 + `scaleY(-1)`）从坐标系层面
 * 规避前插问题（见 `MessageList.tsx` 文件头）。本文件只负责「行的切法」。
 */
import type { MessageDTO } from 'virlen-remote'
import { countLines, hasBody, isDetailOmitted } from './messages'

/** 列表的一行。 */
export type ListRow =
  /** 一条自己成行的消息。`key` 直接用消息 id（与折叠态、`computeItemKey` 同一把钥匙）。 */
  | { kind: 'one'; key: string; message: MessageDTO }
  /** 一段连续的工具调用（≥2 条才成组，见 `buildRows`）。 */
  | { kind: 'tools'; key: string; messages: readonly MessageDTO[] }

/**
 * 组行的 `key` 前缀。
 *
 * 组没有「一条消息的 id」可用（它的成员会随消息入站往后长），但组行又必须有个稳定 key
 * 来承载折叠态：用首条工具消息的 id 加前缀即可 —— 组**在尾部**继续长大时首条不变，
 * 折叠态就跟着它走。
 *
 * ⚠️ 头插（上拉续页）把更早的工具调用接到组前面时，首条会换、key 也就换 —— 那一次折叠态
 * 回到默认（收起）。可接受：那种情况用户本来就在往上翻历史，且组会瞬间变成一个更大的组。
 */
const GROUP_PREFIX = 'tools:'

/**
 * 一条消息在列表里是否**什么都渲染不出来**。
 *
 * 判据必须与 `MessageRow` 的 `return null` 分支**一致**（组件那边也走本函数）：
 * 不一致就会出现「有内容的行被丢掉」（用户看不到消息）或「空行占着位置」。
 *
 * `tool` / `system` 恒为 false：它们的卡片头 / 折叠头永远有东西可看 —— 哪怕正文是空串
 * （那正是「这次调用没有输出」要说的）。
 *
 * §36 起还要看**引用条**：带引用的消息即使正文为空（只引用不写话）也看得见东西，
 * 当成「渲染不出东西」直接丢掉的话，用户会发现自己那条引用凭空消失了。
 * §37 的**文件引用**同理：只附文件不写话也是完全正常的一条消息（“看看这些文件”）。
 */
export function rendersNothing(
  message: Pick<MessageDTO, 'role' | 'text' | 'quotes' | 'files'>,
): boolean {
  if (message.role === 'tool' || message.role === 'system') return false
  if ((message.quotes?.length ?? 0) > 0) return false
  if ((message.files?.length ?? 0) > 0) return false
  return !hasBody(message)
}

/**
 * 一条消息在行模型里怎么落。
 *
 * ⚠️ `buildRows`（切行）与 `visibleRowCount`（数行）**共用**这一个判据：两份各写一遍迟早会漂移，
 * 而漂移的症状是「分页觉得够多了，屏幕上却还是没东西」——静默且难查（只有工具密集的会话才犯）。
 */
export type RowRole =
  /** 工具消息：并入当前工具段（它在屏幕上就是这一段的成员）。 */
  | 'tool'
  /** 什么都渲染不出来：不占行，也**不打断**工具段（屏幕上它不存在）。 */
  | 'none'
  /** 自己占一行。 */
  | 'single'

export function rowRoleOf(message: MessageDTO): RowRole {
  if (message.role === 'tool') return 'tool'
  return rendersNothing(message) ? 'none' : 'single'
}

/**
 * 切行：连续的工具调用合成一组，渲染不出东西的消息直接不占行。
 *
 * 顺序保持原样（列表的顺序是权威，本函数只做「合并 / 丢弃」两种减法）。
 */
export function buildRows(messages: readonly MessageDTO[]): ListRow[] {
  const rows: ListRow[] = []
  /** 正在攒的工具调用段（遇到看得见的东西就收口）。 */
  let run: MessageDTO[] = []
  const flush = () => {
    if (run.length === 1) rows.push({ kind: 'one', key: run[0].id, message: run[0] })
    else if (run.length > 1) rows.push({ kind: 'tools', key: GROUP_PREFIX + run[0].id, messages: run })
    run = []
  }

  for (const message of messages) {
    const role = rowRoleOf(message)
    if (role === 'tool') {
      run.push(message)
      continue
    }
    // 空正文：既不打断工具段（屏幕上它不存在），也不单独成行
    if (role === 'none') continue
    flush()
    rows.push({ kind: 'one', key: message.id, message })
  }
  flush()
  return rows
}

/**
 * 一段消息在列表里会占**几行** —— `buildRows(...).length` 的**免建行**版本（同一套切法）。
 *
 * 用途：**分页补足**。手机端一次取数的判据不能是原始条数 —— 一页 50 条若大半是工具调用
 * （连续工具调用合成一组、纯工具调用轮的空正文消息根本不占行），屏幕上可能只多一两行：
 * 用户滚到顶部（或点「加载更早的消息」）几乎看不到新内容，只能反复上滑 / 反复点。
 * 判据收在这里，让 `store/chat.ts` 能问出「这一页到底让屏幕上多出几行」。
 *
 * ⚠️ 与桌面 Rust 的 `visible_row_count`（`virlen-app` 的 `session_db/visible.rs`）是
 * **同一件事的两种表述**：那边数「工具宿主（带 tool_calls 的 assistant）+ 折叠」，这边数
 * 「工具消息（`role:'tool'` 的结果气泡）合成一段」—— 手机端的工具卡本来就长在结果消息上。
 * 差异只在于「一段工具调用的长度」，不影响这里要回答的问题（这一批够不够多）。
 */
export function visibleRowCount(messages: readonly MessageDTO[]): number {
  let rows = 0
  /** 当前工具段攒了几条（> 0 = 段还没收口；空正文消息不打断它）。 */
  let run = 0
  for (const message of messages) {
    const role = rowRoleOf(message)
    if (role === 'tool') {
      run += 1
      continue
    }
    if (role === 'none') continue
    if (run > 0) rows += 1
    run = 0
    rows += 1
  }
  return run > 0 ? rows + 1 : rows
}

/**
 * **尾部签名** —— 「列表的尾巴是什么」的一句话摘要。
 *
 * 组件（`MessageList`）用它判断**该不该跟着落底**：尾部变了才是「有新内容到了」。
 *
 * ⚠️ 为什么不能拿「消息条数 / 行数」当判据（真机缺陷的根因）：**前插**（加载更早的消息）
 * 同样让条数变 —— 而那时用户正盯着历史看，落底等于把他一把拽到最下面。尾部签名对前插
 * **不变**（前插只动头部：末行的身份、装了几条，都不动）。
 *
 * 末行是工具组时要带上**成员数**：往末尾那个组里并进一条工具调用（`key` 不变、组变大）
 * 也算「尾部有新内容」—— 只比 key 就会漏掉这一次跟随。
 */
export function tailSignature(rows: readonly ListRow[]): string {
  const last = rows[rows.length - 1]
  if (!last) return ''
  return last.kind === 'tools' ? `${last.key}#${last.messages.length}` : last.key
}

/**
 * 工具组的**折叠态视图模型**（组件只负责摆 HTML，这里决定「显示什么」）。
 *
 * 与单条工具卡（`toolView`）同一套口径：只说「调了几次 + 一共多大」，不摆输出预览 ——
 * 想知道是哪几个工具、各自输出了什么，点开就有。
 */
export interface ToolGroupView {
  /** 折叠态的计数文案（`3 次工具调用`）。 */
  label: string
  /** 折叠态右侧的规模（`共 128 行`）；一条正文都没有时见 `omitted` 与空串。 */
  size: string
  /** 有输出被传输档位省略（§33）—— 用来把规模小字压暗一点，与单条卡片同一套提示。 */
  omitted: boolean
}

export function toolGroupView(messages: readonly MessageDTO[]): ToolGroupView {
  let lines = 0
  let omitted = false
  for (const message of messages) {
    lines += countLines(message.text)
    omitted = omitted || isDetailOmitted(message)
  }
  return {
    label: `${messages.length} 次工具调用`,
    // 与 `toolView` 同一条规则：有规模报规模，全被省略就说「已省略」，真没输出就什么都不报
    // （不报「共 0 行」—— 那比承认没有输出更让人困惑）
    size: lines > 0 ? `共 ${lines} 行` : omitted ? '已省略' : '',
    omitted,
  }
}
