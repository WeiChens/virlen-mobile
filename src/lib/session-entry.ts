/**
 * 进入手机端时「默认打开哪个会话」—— **纯函数，可单测**（用户拍板，2026-10）。
 *
 * 两条口径，按优先级：
 * 1. **有会话正在工作**（`SessionSummaryDTO.working === true`，电脑侧权威）→ 打开其中
 *    **最近更新**的那个 —— 用户上一个动作多半就是它，回来第一眼要看到它的进展；
 * 2. 否则 → 打开**最近更新**（`updatedAt` 最大）的那个。
 *
 * ⚠️ **置顶绝不参与这个选择**（用户明确要求）。列表顺序是「置顶优先 → `updatedAt` 倒序」，
 * 于是 `sessions[0]` 是**置顶**那一个、而不是最近用过的那个 —— 直接拿它当默认入口，
 * 表现为「每次打开手机都去一个几天没动的会话」。**置顶的意思是「别让它被淹没」，
 * 不是「每次进来都回到它」**。所以这里只比 `updatedAt`，不看 `pinned`。
 * 两者互不妨碍：抽屉里的排序仍然照抄电脑侧给的顺序（`lib/session-groups.ts` 只分组、不重排）。
 *
 * 并列（含 `updatedAt` 拿不到 / 非数）时保持**列表里靠前**的那一个：兜底路径不引入第二套排序。
 */
import type { SessionSummaryDTO } from 'virlen-remote'

/**
 * 选出进入时要打开的会话；**没有任何会话时返回 `undefined`**（调用方据此保持「新对话」）。
 */
export function pickEntrySession(
  sessions: readonly SessionSummaryDTO[],
): SessionSummaryDTO | undefined {
  return mostRecent(sessions.filter((s) => s.working === true)) ?? mostRecent(sessions)
}

/** `updatedAt` 最大的那个（并列取先出现的；空数组 → `undefined`）。 */
function mostRecent(
  sessions: readonly SessionSummaryDTO[],
): SessionSummaryDTO | undefined {
  let best: SessionSummaryDTO | undefined
  for (const session of sessions) {
    // 严格大于：并列不替换 → 保持列表顺序（电脑侧的顺序本身带语义，见文件头）
    if (!best || session.updatedAt > best.updatedAt) best = session
  }
  return best
}
