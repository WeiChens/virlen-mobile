/**
 * FileIcon —— 「一个条目长什么样」的那个图标（文件面板的行 / 引用 chip / 气泡里的附件都用它）。
 *
 * 为什么要一个共享组件而不是各处自备一张表：图标类别是**一处口径**（`lib/files.ts::fileIconKind`，
 * 它又转调共享包的 `previewKindOf`）。三处各写一张映射表之后，同一个 `.ts` 会出现
 * 「面板里是代码图标、气泡上是通用文件图标」这种没有人会想到去修的不一致。
 *
 * ⚠️ 归类**只看名字与 `isDir`**：手机上拿到的条目信息就是这么点（不看内容，也不额外请求）。
 */
import type { ComponentType, SVGProps } from 'react'
import { fileIconKind, type FileIconKind } from '../../lib/files'
import { IconCode, IconFile, IconFolder, IconImage } from './icons'

/** 图标类别 → 组件（与 `lib/files.ts` 的取值域一一对应）。 */
const ICONS: Record<FileIconKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  dir: IconFolder,
  image: IconImage,
  code: IconCode,
  doc: IconFile,
  data: IconFile,
  file: IconFile,
}

export default function FileIcon({
  name,
  isDir,
  className,
}: {
  name: string
  /** 目录优先于扩展名（`src.ts` 这样的目录名不该被当成代码文件）。 */
  isDir?: boolean
  className?: string
}) {
  const Icon = ICONS[fileIconKind(name, isDir === true)]
  return <Icon className={className} />
}
