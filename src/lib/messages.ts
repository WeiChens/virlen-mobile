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
 */
import type { MessageDTO } from 'virlen-remote'

/** 是否有正文可渲染（空白正文一律视为没有）。 */
export function hasBody(message: Pick<MessageDTO, 'text'>): boolean {
  return message.text.trim().length > 0
}

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
 */
export interface ToolView {
  /** 工具名（如 `read_file`）；电脑侧没解析出来时为 `null`。 */
  name: string | null
  /** 折叠态右侧的规模（如 `3 行`）：决定「要不要展开看」就靠它；无正文时为空串。 */
  size: string
  /** 展开后正文底部的规模（如 `3 行 · 58 字符`）；无正文时为空串。 */
  meta: string
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
  const lines = countLines(message.text)
  const name = message.toolName ?? null
  if (lines === 0) return { name, size: '', meta: '' }
  return {
    name,
    size: `${lines} 行`,
    // 字符数复用 token 环那套口径（`12500 → 12.5k`）：同一个页面上不该有两种缩写规则
    meta: `${lines} 行 · ${formatTokens(message.text.length)} 字符`,
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
