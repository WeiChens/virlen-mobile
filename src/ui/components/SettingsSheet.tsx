/**
 * SettingsSheet —— 外观设置面板（底部抽屉）：**主题** + **界面大小** + 本机名称。
 *
 * 为什么单独一个面板而不是顶栏一个「切换主题」按钮：手机上顶栏已经挤了三个图标
 * （信号 / 新建 / 会话），再挂一个「白天黑夜」图标，用户还得猜它是哪个意思。
 * 设置集中在一处，图标只有一个（齿轮），含义唯一。
 *
 * 面板里**不放**会话级配置（模型 / 目录 / 压缩在会话信息面板）—— 那些是「对当前会话动手」，
 * 这里是「这台手机怎么显示」，改错的代价完全不同。
 *
 * 顺带显示**本机名称**：就是配对时报给电脑的那个名字（`mobileName`），电脑端「已绑定手机」
 * 列表里显示它。放在这里是因为用户唯一能看到它的地方就是电脑，而没有人会为了「我叫什么」
 * 专门跑去看电脑。
 */
import type { ComponentType, SVGProps } from 'react'
import { useStore } from '../../lib/store'
import { prefsStore } from '../../store/prefs'
import { SIZE_PREFS, THEME_PREFS, type SizePref, type ThemePref } from '../../lib/prefs'
import { mobileIdentity } from '../../lib/identity'
import { IconClose, IconContrast, IconMoon, IconSun } from './icons'
import './SettingsSheet.css'
// `.sheet*` 是全局 CSS（不是 CSS Module）：抽屉外壳与 SessionInfoSheet / LinkSheet 共用一份
import './SessionInfoSheet.css'

/** 文案（取值 → 人话）。顺序就是面板里的顺序。 */
const THEME_LABEL: Record<ThemePref, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}
/**
 * 主题档位的图标。**不是装饰**：三个只写着字的方块，用户得逐字读完才知道哪个是「白天」
 * —— 太阳 / 月亮是一眼可辨的。
 */
const THEME_ICON: Record<ThemePref, ComponentType<SVGProps<SVGSVGElement>>> = {
  system: IconContrast,
  light: IconSun,
  dark: IconMoon,
}
const SIZE_LABEL: Record<SizePref, string> = {
  xs: '特小',
  s: '小',
  m: '中',
  l: '大',
  xl: '特大',
}

export default function SettingsSheet({ onClose }: { onClose: () => void }) {
  const prefs = useStore(prefsStore)
  const identity = mobileIdentity()

  return (
    <>
      <div className="sheet__backdrop" onClick={onClose} />
      <section className="sheet" role="dialog" aria-label="设置">
        <header className="sheet__head">
          <span className="sheet__title">设置</span>
          <button type="button" className="sheet__close" aria-label="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        <div className="sheet__body">
          <section className="sheet__block">
            <h3 className="sheet__block-title">主题</h3>
            <div className="settings__seg" role="group" aria-label="主题">
              {THEME_PREFS.map((value) => {
                const Icon = THEME_ICON[value]
                return (
                  <button
                    key={value}
                    type="button"
                    className={`settings__seg-item${prefs.theme === value ? ' is-on' : ''}`}
                    aria-pressed={prefs.theme === value}
                    onClick={() => prefsStore.setTheme(value)}
                  >
                    <Icon width={16} height={16} />
                    {THEME_LABEL[value]}
                  </button>
                )
              })}
            </div>
            <p className="sheet__hint">
              「跟随系统」= 跟着手机本身的深色模式走，手机切主题时这里立刻跟着变。
              选浅色 / 深色则是固定住，不再跟系统。
            </p>
          </section>

          <section className="sheet__block">
            <h3 className="sheet__block-title">界面大小</h3>
            <div className="settings__seg" role="group" aria-label="界面大小">
              {SIZE_PREFS.map((value) => (
                <button
                  key={value}
                  type="button"
                  /* `data-opt` 只给 CSS 用：五档前面各有一个「A」，越大的档 A 越大，
                     并与「特小 / 小 / …」竖向叠放（五列在 360px 屏上放不下横排的 A + 两个字）。
                     那两处尺寸都由 `::before` 生成，不进 DOM 文本 —— 「按钮文案」因此始终只是
                     标签本身（用例按文案找按钮）。 */
                  data-opt={value}
                  className={`settings__seg-item${prefs.size === value ? ' is-on' : ''}`}
                  aria-pressed={prefs.size === value}
                  onClick={() => prefsStore.setSize(value)}
                >
                  {SIZE_LABEL[value]}
                </button>
              ))}
            </div>
            <p className="sheet__hint">
              共五档：特小 / 小 / 中 / 大 / 特大。缩放的是全站文字与主要按钮的尺寸，版式结构不变
              （所以长命令、长摘要在任何一档下也只会重排，不会跑到屏幕外）。
              最小的两档连按钮本身也会变小，因而更难精确点中。
            </p>
          </section>

          <section className="sheet__block">
            <h3 className="sheet__block-title">本机名称</h3>
            <div className="sheet__row">
              <span className="sheet__row-label">
                <span className="settings__name">{identity.name}</span>
                <span className="sheet__row-sub">配对时电脑端「已绑定手机」列表里显示的就是它</span>
              </span>
            </div>
            <p className="sheet__hint">
              名字取本机机型（如 Pixel 7 / iPhone），尾号是本机设备 key 的后四位
              —— 同一个账号的第二台手机不会与它同名。机型探测不到时退回「Android 手机 / iPhone」。
            </p>
          </section>
        </div>
      </section>
    </>
  )
}
