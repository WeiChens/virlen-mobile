/**
 * 手机端图标 —— 内联 SVG，**不引图标库**。
 *
 * 为什么不引库：整个手机端是 PWA，包体直接等于首屏时间；而这里只需要几个图标。
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

/**
 * 工具调用**成功**（圆内对勾）—— 工具卡片 / 工具组头部的状态标志。
 *
 * 为什么画成对角对称的「圆 + 符号」一对（而非单用对勾 / 叉）：同一个头部位置要在
 * 两种状态下都能一眼分辨，外形一致、只换内部符号，比「有图标 / 没图标」更稳定。
 * 颜色由外层 `.tool-card__status--ok` 等类给（图标本身只认 `currentColor`）。
 */
export function IconStatusOk(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.4l2.6 2.6L15.8 9.6" />
    </Svg>
  )
}

/** 工具调用**失败**（圆内叉）—— 与 `IconStatusOk` 成对。 */
export function IconStatusFail(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
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

/**
 * 通讯信号（信号格）——通讯状态面板的入口。
 *
 * 画成递升的四格而不是「一堆波浪」：格数/颜色能直接表达强弱，
 * 而颜色由外层按钮的 `.iconbtn--*` 类控制（图标本身只认 `currentColor`）。
 */
export function IconSignal(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 20v-3M9.3 20v-7M14.7 20v-11M20 20V6" />
    </Svg>
  )
}

/** 通讯信号中断（同一组信号格 + 一道斜杠）——「断了」要比「弱」一眼可辨。 */
export function IconSignalOff(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 20v-3M9.3 20v-7M14.7 20v-11M20 20V6" />
      <path d="M3 4l18 16" />
    </Svg>
  )
}

/**
 * 工具执行（终端提示符 `>_`）—— 工具调用卡片的类别图标。
 *
 * 为什么是终端符而不是扳手：手机端看到的工具输出**全部是命令行输出**（`git diff`、目录树、
 * 构建日志），用户对「这是一段命令结果」的认读比「这是一把扳手」快得多。
 */
export function IconTerminal(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 7l4.5 5L4 17" />
      <path d="M12 17h8" />
    </Svg>
  )
}

/** 设置（齿轮）—— 主题 / 界面大小的入口。 */
export function IconSettings(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.49 1z" />
    </Svg>
  )
}

/** 浅色 / 深色主题（半个圆 —— 对比）。 */
export function IconContrast(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
    </Svg>
  )
}

/** 浅色主题（太阳）。 */
export function IconSun(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  )
}

/** 深色主题（月亮）。 */
export function IconMoon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </Svg>
  )
}

/** 向下（回到底部 / 展开）。 */
export function IconChevronDown(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  )
}

/* ── 文件面板（§37）─────────────────────────────────────────────── */

/** 返回上一级 / 退出预览。 */
export function IconBack(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M15 5l-7 7 7 7" />
    </Svg>
  )
}

/** 下载（从电脑存到手机）。 */
export function IconDownload(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 4v11" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </Svg>
  )
}

/** 上传（从手机存到电脑）。 */
export function IconUpload(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 16V5" />
      <path d="M7.5 9.5L12 5l4.5 4.5" />
      <path d="M4.5 19.5h15" />
    </Svg>
  )
}

/** 编辑（改电脑上那份文本 / 代码文件）。 */
export function IconEdit(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M5 19l3.8-.9 9-9a2.2 2.2 0 0 0-3.1-3.1l-9 9L5 19z" />
      <path d="M13.6 7.6l2.8 2.8" />
    </Svg>
  )
}

/** 图片文件（文件类型图标）。 */
export function IconImage(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M4.5 17l4.5-4.5 3.5 3.5 3-2.5 4 3.5" />
    </Svg>
  )
}

/** 代码文件（文件类型图标）。 */
export function IconCode(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M9 8l-4 4 4 4" />
      <path d="M15 8l4 4-4 4" />
    </Svg>
  )
}

/** 普通文件（文件类型图标）。 */
export function IconFile(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
      <path d="M14 3.5V8.5h5" />
    </Svg>
  )
}
