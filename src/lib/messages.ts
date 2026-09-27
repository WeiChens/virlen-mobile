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
 *    解析不到时**不猜**，只显示「工具」；
 * 3. **压缩摘要等 `system` 消息照常显示**：用户需要看到「这里发生过一次上下文压缩」。
 */
import type { MessageDTO } from 'virlen-remote'

/** 是否有正文可渲染（空白正文一律视为没有）。 */
export function hasBody(message: Pick<MessageDTO, 'text'>): boolean {
  return message.text.trim().length > 0
}

/** 工具气泡标题：`工具 · read_file`（拿不到名字时只显示「工具」，不编造）。 */
export function toolLabel(message: MessageDTO): string {
  return message.toolName ? `工具 · ${message.toolName}` : '工具'
}

/** 工具气泡折叠态的摘要：第一行非空文本，超长截断。 */
export function toolPreview(message: MessageDTO, max = 60): string {
  const firstLine = message.text.split('\n').find((line) => line.trim())
  if (!firstLine) return '(无输出)'
  const trimmed = firstLine.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
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
