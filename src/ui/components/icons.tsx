/**
 * 手机端图标 —— 内联 SVG，**不引图标库**。
 *
 * 为什么不引库：整个手机端是 PWA，包体直接等于首屏时间；而这里只需要 6 个图标。
 * 统一 20×20 视口、`currentColor` 描边（颜色由 CSS 控制，跟随按钮状态）。
 */
import type { SVGProps } from 'react'

function Svg({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** 会话列表（抽屉入口）。 */
export function IconList(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 6h16M4 12h16M4 18h10" />
    </Svg>
  )
}

/** 新对话。 */
export function IconPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

/** 关闭 / 收起。 */
export function IconClose(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  )
}

/** 会话信息。 */
export function IconInfo(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Svg>
  )
}

/** 选中。 */
export function IconCheck(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M5 13l4 4L19 7" />
    </Svg>
  )
}

/** 工作目录。 */
export function IconFolder(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Svg>
  )
}

/** 模型（芯片）。 */
export function IconChip(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4" />
    </Svg>
  )
}

/** 上下文 / 占用（环形进度以外的一格）。 */
export function IconGauge(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="M12 18l4-5" />
    </Svg>
  )
}
