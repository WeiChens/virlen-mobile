/**
 * MessageActionsSheet —— 长按消息气泡弹出的**动作面板**（§36：复制 / 引用 / 删除）。
 *
 * ## 为什么是「贴底面板」而不是「按压点浮层」
 *
 * 消息区是虚拟列表（`@tanstack/react-virtual`），它的祖先节点带 `transform` / `overflow` ——
 * 在那种容器里做 `absolute` 浮层会被裁剪或错位，而 `fixed` 又要处理视口钳制、
 * 滚动即关闭、以及「手指挡住了菜单」这三件事。贴底面板把这三个问题一次消掉：
 * 位置固定、拇指够得到、与既有的会话信息 / 通讯状态面板同一种手感。
 *
 * ## 这一层只负责「摆 HTML」
 *
 * **哪些项出现、哪项为什么不可点**一律由 `lib/messages.ts::planMessageActions` 决定
 * （纯函数、可单测）。组件不去重新判断角色或能力 —— 两处各判一次必然漂移，
 * 而漂移的后果是「界面上有个点了没反应的按钮」。
 *
 * 外壳沿用 `<SessionInfoSheet>` 的 `.sheet__backdrop`（与 LinkSheet / SettingsSheet 同一做法：
 * 底座样式只定义一处，其余面板共用）。
 */
import type { MessageDTO } from 'virlen-remote'
import {
  MESSAGE_ACTION_LABELS,
  messageRoleLabel,
  type MessageAction,
  type MessageActionItem,
} from '../../lib/messages'
import { IconClose } from './icons'
import './MessageActionsSheet.css'

interface Props {
  /** 正在操作的那条消息的角色（只用于标题那一行）。 */
  role: MessageDTO['role']
  /** 标题里的单行预览（由 `firstLinePreview` 产出，调用方负责截断）。 */
  preview: string
  /** 面板里展示的项（含灰显项与原因）——**空数组时调用方不该打开面板**。 */
  items: readonly MessageActionItem[]
  onPick: (action: MessageAction) => void
  onClose: () => void
}

export default function MessageActionsSheet({ role, preview, items, onPick, onClose }: Props) {
  return (
    <>
      <div className="sheet__backdrop" onClick={onClose} />
      <section className="actpanel" role="dialog" aria-label="消息操作">
        <header className="actpanel__head">
          <span className="actpanel__target">
            <span className="actpanel__who">{messageRoleLabel(role)}</span>
            {preview && <span className="actpanel__preview">{preview}</span>}
          </span>
          <button type="button" className="actpanel__close" aria-label="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        <div className="actpanel__items">
          {items.map((item) => (
            <div key={item.action} className="actpanel__item">
              <button
                type="button"
                className={`actpanel__btn${item.action === 'delete' ? ' actpanel__btn--danger' : ''}${item.disabled ? ' is-disabled' : ''}`}
                data-action={item.action}
                disabled={item.disabled}
                onClick={() => onPick(item.action)}
              >
                {MESSAGE_ACTION_LABELS[item.action]}
              </button>
              {/* 不可点的项必须说清原因 —— 否则用户只看到「灰着的按钮」，会当成坏了 */}
              {item.hint && <p className="actpanel__hint">{item.hint}</p>}
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
