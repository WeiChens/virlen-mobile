/**
 * 文件面板的纯函数层（手机端）—— 与共享包的分工是：**口径**在 `virlen-remote`（分类 / 限额 /
 * base64 / 路径 / 体积文案），这里只放「手机上怎么显示、怎么存」。
 *
 * ⚠️ **不要在这里另写一份口径**：体积格式化、预览分类、预览限额都已经在共享包里，
 * 两端各写一份的症状是「电脑说这是文本、手机按二进制显示」这种谁也说不清的错位。
 * 本文件只做三件事：图标类别、面包屑、以及**本机能力**（下载上限、系统分享能不能用）。
 */
import {
  formatFileSize,
  isEditableKind,
  previewKindOf,
  previewLimitOf,
  type FilePreviewKind,
  type MessageFileRef,
} from 'virlen-remote'

/**
 * 手机端**下载**上限（64MB）。
 *
 * ⚠️ 这条**不是协议约定**，而是本机的内存纪律：分块收下来的字节要拼成一个 Blob 才能交给
 * 系统分享 / 下载，而 Blob 在手机上就是内存 —— 点开一个 500MB 的视频时崩掉的是整个标签页
 * （用户看到的是白屏 + 重新登录）。上传侧的上限（32MB）在协议里，因为那是两端的约定；
 * 这一条只在手机侧，因为「这台手机吃不吃得下」只有它自己知道。
 */
export const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024

/** 图标类别（纯展示，不涉协议）。 */
export type FileIconKind = 'dir' | 'image' | 'code' | 'doc' | 'data' | 'file'

const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'py', 'rb', 'php',
  'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'sh', 'bash',
  'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'lua', 'dart', 'scala', 'r', 'pl', 'asm',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'xml', 'svg',
])
const DATA_EXTS = new Set([
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties',
  'env', 'csv', 'tsv', 'lock',
])

/** 条目 → 图标类别（目录 / 图片 / 代码 / 数据 / 文档 / 其它）。 */
export function fileIconKind(name: string, isDir: boolean): FileIconKind {
  if (isDir) return 'dir'
  /*
   * 先问共享包的分类（两端同一张表），再在「文本」这一档里细分图标：
   * 分类一旦与共享包不一致，就会出现「电脑已经把 .log 当文本发下来、手机却给它一个通用文件图标」
   * 这种没必要的不一致。`binary` 一律通用文件图标 —— 它本来就只能下载。
   */
  const kind = previewKindOf(name)
  if (kind === 'image') return 'image'
  if (kind === 'markdown') return 'doc'
  if (kind === 'binary') return 'file'
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (CODE_EXTS.has(ext)) return 'code'
  if (DATA_EXTS.has(ext)) return 'data'
  return 'doc'
}

/** 面包屑的一段（`path` 是相对工作目录的路径，`''` = 根）。 */
export interface Crumb {
  name: string
  path: string
}

/**
 * 相对路径 → 面包屑（第一段是工作目录本身）。
 *
 * 第一段的名字由调用方给（会话的工作目录名）—— 根路径是空串，不该让组件自己去想
 * 「空串显示什么」。
 */
export function crumbsOf(relPath: string, rootName: string): Crumb[] {
  const crumbs: Crumb[] = [{ name: rootName, path: '' }]
  let acc = ''
  for (const part of relPath.split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part
    crumbs.push({ name: part, path: acc })
  }
  return crumbs
}

/** 工作目录的显示名（末级目录名；拿不到就退回整串）。 */
export function workspaceName(absPath: string): string {
  const normalized = (absPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const index = normalized.lastIndexOf('/')
  const last = index < 0 ? normalized : normalized.slice(index + 1)
  return last || normalized || '工作目录'
}

/** 进上一级目录（根目录的上一级仍是根）。 */
export function parentDir(relPath: string): string {
  const index = relPath.lastIndexOf('/')
  return index < 0 ? '' : relPath.slice(0, index)
}

/**
 * 纯文本文件（预览时按文本解码；能编辑的就是这一档）。
 *
 * 实现**转调共享包**的 `isEditableKind`：这两个判断是同一个集合（文本 / 代码 / Markdown），
 * 各写一份的话，将来共享包加一种可编辑类型时会出现「能编辑却按二进制预览」这种错位。
 */
export function isTextual(kind: FilePreviewKind): boolean {
  return isEditableKind(kind)
}

/**
 * 字节 → 文本（宽容解码）。
 *
 * `fatal: false`：一个 GBK 编码的中文注释不该让整个预览失败 —— 那是「看不到文件」，
 * 比「有个别乱码字符」难受得多。顺手去掉 BOM（它会在首行前面显示成一个怪字符）。
 */
export function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 预览限额（**直接用共享包那一张表**，手机端不做二次判断）。 */
export function previewLimit(kind: FilePreviewKind): number {
  return previewLimitOf(kind)
}

/** 统一的体积文案（列表行 / 预览头 / 进度 / 文件引用 chip 都读它，避免四处各写一句）。 */
export function sizeLabel(bytes: number): string {
  return formatFileSize(bytes)
}

/**
 * 把「当前目录 + 条目名」做成协议要的**文件引用**（§37）。
 *
 * 为何要归一化：电脑侧给的工作目录可能是 `E:\proj\` 也可能是 `E:/proj` —— 直接拼出来的
 * 字串会带 `\/` 或双斜杠。而 `path` 是**同一个文件在协议里的唯一写法**（电脑侧
 * `sanitizeFileRefs` 也会再归一一次，但两端拼出来的字串首先要能自己对得上 ——
 * 「这个文件已经引用过了」的比对、以及气泡上回显的 chip 都靠它）。
 *
 * `name` 必填（chips 显示的就是它）；`isDir` / `size` 是展示元数据，没有就不带
 * （空字段会在消息里、导出里、请求体里一直堆着）。
 */
export function toFileRef(
  dirAbsPath: string,
  name: string,
  options: { isDir?: boolean; size?: number } = {},
): MessageFileRef {
  const dir = (dirAbsPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return {
    path: dir ? `${dir}/${name}` : name,
    name,
    // 目录没有字节数：即便调用方误传了也不带（「目录 12 KB」是一句假话）
    ...(options.isDir ? { isDir: true } : options.size != null ? { size: options.size } : {}),
  }
}

/** 下载前的本机内存检查（返回拒绝原因；`null` = 可以下）。 */
export function downloadGuard(size: number, limit = DOWNLOAD_MAX_BYTES): string | null {
  if (size <= limit) return null
  return `文件较大（${formatFileSize(size)}），超过手机端下载上限 ${formatFileSize(limit)} —— 请在电脑上取用。`
}

/**
 * 能否用系统分享面板（iOS：可「存储到文件」；Android：可存到相册 / 文件）。
 *
 * 判定顺序（**先问能力，再调用**）：`navigator.canShare({files})` 说不行就别调 `share()` ——
 * 后者会抛一个用户看不懂的 `NotAllowedError`，而那时文件已经下载完了。
 */
export function canShareFiles(): boolean {
  if (typeof navigator === 'undefined' || typeof File === 'undefined') return false
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean
    share?: (data: ShareData) => Promise<void>
  }
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false
  try {
    // 用一个 0 字节的假文件问能力：canShare 关心的是「带文件的分享」这个能力，不是内容
    return nav.canShare({ files: [new File([new Uint8Array(0)], 'probe.txt', { type: 'text/plain' })] })
  } catch {
    return false
  }
}

/** 触发一次浏览器下载（`<a download>` 兜底路径）。返回是否真的发起了。 */
export function triggerDownload(blobUrl: string, filename: string): boolean {
  if (typeof document === 'undefined') return false
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  // 立刻摘掉节点（下载已经开始，它不再需要留在 DOM 里）
  document.body.removeChild(anchor)
  return true
}

/** 进度百分比（0..100；总量未知时给 0，UI 那时显示不确定态）。 */
export function percentOf(loaded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((loaded / total) * 100)))
}
