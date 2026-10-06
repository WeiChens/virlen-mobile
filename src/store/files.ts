/**
 * 文件面板 store（手机端）—— 浏览会话工作目录 / 预览 / 下载 / 上传 / **编辑保存**。
 *
 * ## 四条纪律
 *
 * 1. **电脑侧是权威**：文件类型、MIME、大小、最终落盘名一律以 `host.file.*` 的应答为准；
 *    本端只做「下一步该发什么请求」的判断（例如已知是二进制就不去读它 —— 省一趟流量）。
 * 2. **一切大字节都要分块**（`FILE_CHUNK_BYTES`）：一次 RPC 的载荷有上限（帧层是 12KB 分片的
 *    JSON），整文件塞一次会同时炸掉两端的组装缓冲。进度也由此天然可得。
 * 3. **非中继 + 能力门**：`blockReason()` 把两件事合成一句话（链路是中继 / 电脑端没开这个功能），
 *    UI 拿它**置灰整个面板并说明**；但真正的拒绝仍在电脑侧（本端不显示入口 ≠ 隔离）。
 * 4. **编辑保存 = 覆写 + 版本校验**（§37）：写之前把打开时的 `mtimeMs` / 字节数回传给电脑侧，
 *    不一致就是「电脑上已经变了」→ 由用户在 UI 上选「重新载入 / 强制覆盖」。换行风格、BOM 与
 *    严格 UTF-8 的往返口径全在共享包（`encodeEditedText` / `decodeUtf8Strict`）：
 *    **本 store 不自己拼字节**，否则「改一行、整篇行尾被改写」这类事故就没人拦得住。
 *
 * ## 与 `chatStore` 的关系
 *
 * 只读它的会话信息（工作目录名），不订阅它的状态；本 store 的状态只在面板打开时才有意义，
 * 关闭即清空（避免把「上次看的目录」带到下一次）。
 */
import {
  BridgeError,
  FILE_BROWSE_CAPABILITY,
  FILE_CHUNK_BYTES,
  FILE_DOWNLOAD_CAPABILITY,
  FILE_EDIT_CAPABILITY,
  FILE_EDIT_MAX_BYTES,
  FILE_UPLOAD_CAPABILITY,
  FILE_UPLOAD_MAX_BYTES,
  MESSAGE_FILE_CAPABILITY,
  applyEolStyle,
  base64ToBytes,
  bytesToBase64,
  decodeUtf8Strict,
  detectEolStyle,
  encodeEditedText,
  fileTransferDeniedReason,
  formatFileSize,
  hasUtf8Bom,
  mimeTypeOf,
  previewKindOf,
  previewLimitOf,
  type EolStyle,
  type FileEntryDTO,
  type FilePreviewKind,
  type FileReadResult,
} from 'virlen-remote'
import { Store } from '../lib/store'
import { getCaller } from '../api/active'
import { linkStore } from './link'
import { connectionStore } from './connection'
import {
  DOWNLOAD_MAX_BYTES,
  canShareFiles,
  decodeText,
  downloadGuard,
  isTextual,
  parentDir,
  triggerDownload,
} from '../lib/files'

/** 一次在途传输（上传 / 下载共用形状）。 */
export interface TransferProgress {
  /** 文件名（展示用）。 */
  name: string
  /** 已传字节数。 */
  loaded: number
  /** 总字节数。 */
  total: number
  /** 上传多选时的进度（`1/3`）；下载恒为 `undefined`。 */
  index?: number
  count?: number
}

/** 预览态（`text` / `url` 二者其一，取决于类别）。 */
export interface PreviewState {
  relPath: string
  name: string
  kind: FilePreviewKind
  mime: string
  size: number
  /** 文本 / Markdown 正文。 */
  text?: string
  /** 图片的 ObjectURL（关闭预览时 revoke，否则整张图的内存一直挂着）。 */
  url?: string
  /** 不能预览的原因（`kind==='binary'` 或超限）；有它 = UI 只给下载。 */
  reason?: string
  /**
   * 能不能编辑（四条同时满足，见 `preview()`）。
   *
   * 它只回答「**这一份文件**能不能编辑」；电脑端认不认 `file.edit` 是另一码（UI 另看
   * `fileStore.canEdit()`）—— 两件事分开，能力位变化就不用重读文件。
   */
  editable: boolean
  /** 不能编辑时给用户的一句话（`editable` 为 true 时不看它）。 */
  editBlocked?: string
  /** 打开时的版本凭据（`host.file.read` 的 `mtimeMs`）—— 没有它就没有冲突校验，也就不给编辑。 */
  mtimeMs?: number
  /** 原文的换行风格 / 是否带 BOM（进编辑区时带走，保存时原样还原）。 */
  eol?: EolStyle
  bom?: boolean
}

/** 编辑态（同一面板里的第三层视图：目录 / 预览 / 编辑）。 */
export interface EditorState {
  /** 相对工作目录的路径（保存时拆回 dir + name）。 */
  relPath: string
  name: string
  /** 编辑区里的文本。**只有 LF** —— HTML 的 textarea 语义如此，保存时按 `eol` 还原。 */
  draft: string
  /** 打开时的原文（同样 LF 化）——「改了没有」只看它俩相不相等。 */
  base: string
  eol: EolStyle
  bom: boolean
  /** 打开时电脑侧的版本凭据 / 字节数（保存时回传，给电脑侧做冲突校验）。 */
  mtimeMs: number
  size: number
  /** 保存中（按钮转圈 + 禁点）。 */
  saving: boolean
  /** 电脑侧回了冲突：UI 给「重新载入 / 强制覆盖」两个选择，**草稿原样留着**。 */
  conflict?: string
  /** 非冲突的失败原因（编码 / 权限 / IO…）。 */
  error?: string
  /** 正在重新载入电脑上的最新版本。 */
  reloading?: boolean
}

export interface FilesState {
  open: boolean
  sessionId: string | null
  /** 当前目录（**相对**会话工作目录；`''` = 根）。 */
  relPath: string
  /** 当前目录的绝对路径（电脑侧给的，只用于显示）。 */
  absPath: string
  entries: FileEntryDTO[]
  loading: boolean
  /** 条目过多被电脑侧截断（如实告知，不假装目录就这么大）。 */
  truncated: boolean
  error?: string
  /** 一次性提示（上传成功 / 名字被改成「- 副本」等）。 */
  notice?: string
  preview: PreviewState | null
  previewLoading: boolean
  /** 编辑态（`null` = 不在编辑）。开关面板会一并清掉。 */
  editor: EditorState | null
  upload: TransferProgress | null
  download: TransferProgress | null
}

const INITIAL: FilesState = {
  open: false,
  sessionId: null,
  relPath: '',
  absPath: '',
  entries: [],
  loading: false,
  truncated: false,
  preview: null,
  previewLoading: false,
  editor: null,
  upload: null,
  download: null,
}

class FilesStore extends Store<FilesState> {
  constructor() {
    super(INITIAL)
  }

  /* ───────────────────────────── 门槛 ───────────────────────────── */

  /**
   * 面板当前能不能用（`null` = 能用）。
   *
   * 两件事合成一句话：
   * - **能力**：电脑端 hello 应答里有没有 `file.browse` / `file.download`
   *   （旧电脑端没有 → 入口不该出现，§3.5「没有的东西不显示」）；
   * - **链路**：非中继（与电脑侧同一句话，来自共享包 `fileTransferDeniedReason`）。
   *   注意 `unknown` **放行** —— 同源联调 / 非 WebRTC 链路就落在这一档。
   */
  blockReason(): string | null {
    const caps = connectionStore.getSnapshot().capabilities
    if (!caps.includes(FILE_BROWSE_CAPABILITY) || !caps.includes(FILE_DOWNLOAD_CAPABILITY)) {
      return '电脑端未开启「文件浏览」（请在电脑端手机控制设置里授权）'
    }
    return fileTransferDeniedReason(linkStore.getSnapshot().path)
  }

  /** 上传是否可用（能力 + 当前没有在途传输）。 */
  canUpload(): boolean {
    const caps = connectionStore.getSnapshot().capabilities
    return caps.includes(FILE_UPLOAD_CAPABILITY) && this.getSnapshot().upload == null
  }

  /**
   * 编辑保存是否可用（电脑端认 `file.edit`）。
   *
   * ⚠️ 与 `blockReason()` 里的只读两档不同：这里缺了**不能**把整个面板置灰 —— 旧电脑端
   * 依旧能浏览 / 预览 / 下载，只是没有「编辑」入口（旧电脑端会静默忽略 `overwrite`，
   * 一次覆盖保存会退化成「另存为 - 副本」，用户以为改了、原文件其实没动）。
   */
  canEdit(): boolean {
    return connectionStore.getSnapshot().capabilities.includes(FILE_EDIT_CAPABILITY)
  }

  /**
   * 「引用到对话」是否可用（电脑端认 `message.file`，§37）。
   *
   * ⚠️ 与 `canEdit()` 同一档：缺了**不能**把整个面板置灰 —— 浏览 / 预览 / 下载 / 编辑都还能用，
   * 只是没有「引用」入口（旧电脑端会把 `files` 静默丢掉：用户以为附上了，AI 从未看到）。
   */
  canReference(): boolean {
    return connectionStore.getSnapshot().capabilities.includes(MESSAGE_FILE_CAPABILITY)
  }

  /** 是否正忙（在途传输 / 正在列目录 / 正在读预览 / 正在保存）—— UI 据此置灰按钮。 */
  isBusy(): boolean {
    const s = this.getSnapshot()
    return (
      s.loading ||
      s.previewLoading ||
      s.upload != null ||
      s.download != null ||
      s.editor?.saving === true ||
      s.editor?.reloading === true
    )
  }

  /* ───────────────────────────── 开关面板 ───────────────────────────── */

  /** 打开面板并列出根目录。重复打开同一个会话 = 重新列一次（目录可能已经变了）。 */
  open(sessionId: string): void {
    this.releasePreview()
    this.setState({ ...INITIAL, open: true, sessionId })
    void this.load('')
  }

  close(): void {
    this.releasePreview()
    this.setState({ ...INITIAL })
  }

  /** 清掉一次性提示与错误（面板里下一次操作开始前调）。 */
  clearMessages(): void {
    this.setState((s) => (s.error || s.notice ? { ...s, error: undefined, notice: undefined } : s))
  }

  /* ───────────────────────────── 列目录 ───────────────────────────── */

  private async load(relPath: string): Promise<void> {
    const sessionId = this.getSnapshot().sessionId
    if (!sessionId) return
    this.releasePreview()
    this.setState((s) => ({ ...s, loading: true, error: undefined, notice: undefined, preview: null }))
    try {
      const result = await getCaller().call('host.file.list', { sessionId, path: relPath })
      // 面板已关 / 已换会话 → 这次应答作废（否则会把上一次的目录写进新开的那个面板）
      if (this.getSnapshot().sessionId !== sessionId) return
      this.setState((s) => ({
        ...s,
        loading: false,
        relPath: result.relPath,
        absPath: result.absPath,
        entries: result.entries,
        truncated: result.truncated === true,
      }))
    } catch (err) {
      if (this.getSnapshot().sessionId !== sessionId) return
      this.setState((s) => ({ ...s, loading: false, error: messageOf(err) }))
    }
  }

  /** 重新列当前目录（上传 / 删除之后刷新）。 */
  reload(): Promise<void> {
    return this.load(this.getSnapshot().relPath)
  }

  /** 进入某个目录（面包屑 / 目录条目都走它）。 */
  enter(relPath: string): Promise<void> {
    return this.load(relPath)
  }

  /** 回上一级。 */
  up(): Promise<void> {
    return this.load(parentDir(this.getSnapshot().relPath))
  }

  /* ───────────────────────────── 预览 ───────────────────────────── */

  /**
   * 点开一条：目录进目录，文件开预览。
   *
   * **先按本端表判断能不能预览**，再去读字节 —— 一个 200MB 的 `.bin` 没有必要先读一块
   * （350KB 的 base64）才发现「它不能预览」。真正的类型仍以电脑侧应答为准（它可能和我们
   * 猜的不一样），所以读回来的 `kind` 会覆盖本地判断。
   */
  async openEntry(entry: FileEntryDTO): Promise<void> {
    if (entry.isDir) {
      await this.load(joinPath(this.getSnapshot().relPath, entry.name))
      return
    }
    await this.preview(entry.name, entry.size)
  }

  /** 读一份文件进预览。 */
  async preview(name: string, size: number): Promise<void> {
    const { sessionId, relPath } = this.getSnapshot()
    if (!sessionId) return
    const path = joinPath(relPath, name)
    const localKind = previewKindOf(name)
    const limit = previewLimitOf(localKind)
    this.releasePreview()

    // 读不了的情形（二进制 / 超限）直接给结论，连一次请求都不发
    if (limit === 0 || size > limit || size === 0) {
      this.setState((s) => ({
        ...s,
        preview: {
          relPath: path,
          name,
          kind: localKind,
          mime: '',
          size,
          reason:
            limit === 0
              ? '这类文件不能在手机上预览，请下载后用其它应用打开。'
              : size === 0
                ? '这是一个空文件。'
                : `文件较大（${formatFileSize(size)}），超过手机端预览上限 ${formatFileSize(limit)}，请下载后查看。`,
          // 连预览都不给，自然不给编辑
          editable: false,
        },
        previewLoading: false,
      }))
      return
    }

    this.setState((s) => ({ ...s, previewLoading: true, error: undefined, notice: undefined }))
    try {
      const { bytes, head } = await this.readAll(sessionId, path)
      const kind = previewKindOf(name)
      const mime = mimeTypeOf(name)
      if (kind === 'image') {
        const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mime }))
        this.setState((s) => ({
          ...s,
          previewLoading: false,
          preview: { relPath: path, name, kind, mime, size: head.size, url, editable: false },
        }))
        return
      }
      /*
       * 文本 / Markdown / 代码：顺手算出「能不能编辑」。四条同时成立才行 ——
       * ① 类别可编辑（纯文本 / 代码 / Markdown 源码；图片与二进制没有「编辑」这一说）；
       * ② **严格** UTF-8。宽容解码（GBK 注释）看着能用，但存回去就是**毁文件**
       *    （原来在电脑上还能正常看，之后连电脑上也读不回来）→ 这种情况只给「请在电脑上改」；
       * ③ 字节数在编辑上限（256KB）内 —— 比预览上限（1MB）严，因为编辑要回传整篇；
       * ④ 电脑侧给了版本凭据（`mtimeMs`）—— 没它就做不了冲突校验，而**不许盲写**。
       */
      const textual = isTextual(kind)
      const strict = textual ? decodeUtf8Strict(bytes) : null
      const blocked = !textual
        ? '这类文件不能在手机上编辑。'
        : strict == null
          ? '这份文件的编码不是 UTF-8，在手机上编辑会毁掉内容 —— 请在电脑上改。'
          : bytes.length > FILE_EDIT_MAX_BYTES
            ? `文件较大（${formatFileSize(bytes.length)}），超过手机端编辑上限 ${formatFileSize(FILE_EDIT_MAX_BYTES)} —— 请在电脑上改。`
            : head.mtimeMs == null
              ? '电脑端没有给出这份文件的版本信息，暂不支持在手机上编辑。'
              : undefined
      this.setState((s) => ({
        ...s,
        previewLoading: false,
        preview: {
          relPath: path,
          name,
          kind,
          mime,
          // 大小以**电脑侧首块**给的为准（列表里的那份可能已经旧了）
          size: head.size,
          // 解码同样：严格解码能过就用它的结果，否则退回宽容解码（只给看，不给编）
          ...(textual ? { text: strict ?? decodeText(bytes) } : {}),
          editable: blocked == null,
          ...(blocked != null ? { editBlocked: blocked } : {}),
          ...(head.mtimeMs != null ? { mtimeMs: head.mtimeMs } : {}),
          ...(strict != null ? { eol: detectEolStyle(strict), bom: hasUtf8Bom(bytes) } : {}),
        },
      }))
    } catch (err) {
      this.setState((s) => ({ ...s, previewLoading: false, error: messageOf(err) }))
    }
  }

  closePreview(): void {
    this.releasePreview()
    this.setState((s) => ({ ...s, preview: null, editor: null }))
  }

  /* ───────────────────────────── 编辑（覆写保存） ───────────────────────────── */

  /** 当前有没有未保存的改动（UI 拿它标「未保存」与二次确认）。 */
  isDirty(): boolean {
    const editor = this.getSnapshot().editor
    return editor ? editor.draft !== editor.base : false
  }

  /**
   * 进编辑区（从当前预览的那份文件）。
   *
   * 文本这一步先**把换行拉平成 LF**：HTML 的 `textarea` 语义只有 LF，若把原文的 CRLF 直接塞给
   * 它，浏览器会自己规范化一次 —— 于是「光标位置 / 有没有改动」全部对不上。拉平后
   * 保存时由共享包的 `encodeEditedText` 按原风格还原。
   */
  startEdit(): void {
    const { preview } = this.getSnapshot()
    if (!preview || preview.text == null) return
    if (!preview.editable || preview.mtimeMs == null || !this.canEdit()) return
    const left = applyEolStyle(preview.text, 'lf')
    this.setState((s) => ({
      ...s,
      error: undefined,
      notice: undefined,
      editor: {
        relPath: preview.relPath,
        name: preview.name,
        draft: left,
        base: left,
        eol: preview.eol ?? 'lf',
        bom: preview.bom === true,
        mtimeMs: preview.mtimeMs as number,
        size: preview.size,
        saving: false,
      },
    }))
  }

  /** 编辑区文本变了（每次按键）。 */
  updateDraft(text: string): void {
    this.setState((s) => (s.editor ? { ...s, editor: { ...s.editor, draft: text } } : s))
  }

  /** 关掉编辑区（丢掉草稿）—— 有改动时调用方先确认，别在这里弹窗。 */
  cancelEdit(): void {
    this.setState((s) => (s.editor ? { ...s, editor: null } : s))
  }

  /**
   * 保存（覆写电脑上那份文件）。
   *
   * `force` = 用户在冲突提示里选了「强制覆盖」：先取一次电脑上的**当前版本**再写。
   * 「强制」是「我知道会盖掉你现在这一版」，**不是盲写** —— 电脑侧要求必须带版本凭据，
   * 没有版本根本写不进去（那条纪律是为了让「吞掉 AI 刚写的代码」只可能发生在用户明确点了
   * 强制覆盖之后）。
   */
  async saveEdit(force = false): Promise<void> {
    const state = this.getSnapshot()
    const editor = state.editor
    const sessionId = state.sessionId
    if (!editor || editor.saving || !sessionId) return
    this.setState((s) =>
      s.editor ? { ...s, editor: { ...s.editor, saving: true, conflict: undefined, error: undefined } } : s,
    )
    try {
      let base = { mtimeMs: editor.mtimeMs, size: editor.size }
      if (force) {
        // 只读 1 个字节：要的是「现在这一版」的版本凭据（内容不要），顺带少传 256KB
        const fresh = await getCaller().call('host.file.read', {
          sessionId,
          path: editor.relPath,
          offset: 0,
          length: 1,
        })
        if (fresh.mtimeMs == null) throw new Error('电脑端没有给出这份文件的版本，无法覆盖')
        base = { mtimeMs: fresh.mtimeMs, size: fresh.size }
      }
      // 编码出口只有共享包那一个：换行还原 + BOM 还原都在里面
      const bytes = encodeEditedText(editor.draft, { eol: editor.eol, bom: editor.bom })
      const begin = await getCaller().call('host.file.write.begin', {
        sessionId,
        dir: parentDir(editor.relPath),
        name: editor.name,
        size: bytes.length,
        overwrite: true,
        expectMtimeMs: base.mtimeMs,
        expectSize: base.size,
      })
      let sent = 0
      while (sent < bytes.length) {
        const slice = bytes.subarray(sent, sent + FILE_CHUNK_BYTES)
        await getCaller().call('host.file.write.chunk', {
          uploadId: begin.uploadId,
          offset: sent,
          data: bytesToBase64(slice),
        })
        sent += slice.length
      }
      const done = await getCaller().call('host.file.write.finish', { uploadId: begin.uploadId })
      /*
       * 保存成功：**退出编辑区**，并把预览换成刚写上去的内容 ——
       * 用户要的证据是「它真的变了」，而不是一句提示。
       */
      this.setState((s) => ({
        ...s,
        editor: null,
        notice: `已保存「${done.name}」`,
        preview: s.preview
          ? {
              ...s.preview,
              text: editor.draft,
              size: done.size,
              // 回执里的 mtime 是下一次保存的版本凭据（不改的话连存第二次必然「冲突」）
              ...(done.mtimeMs != null ? { mtimeMs: done.mtimeMs } : {}),
            }
          : s.preview,
      }))
    } catch (err) {
      const conflict = err instanceof BridgeError && err.code === 'E_CONFLICT'
      this.setState((s) =>
        s.editor
          ? {
              ...s,
              editor: {
                ...s.editor,
                saving: false,
                // 冲突不是「失败」：草稿必须原样留着，让用户决定重新载入还是强制覆盖
                ...(conflict
                  ? { conflict: messageOf(err) }
                  : { error: messageOf(err) }),
              },
            }
          : s,
      )
    }
  }

  /** 冲突要两个选择，不能只有「确定」—— 所以不用 `confirm`，而是在编辑区里给两个按钮。 */
  dismissConflict(): void {
    this.setState((s) => (s.editor ? { ...s, editor: { ...s.editor, conflict: undefined } } : s))
  }

  /** 重新载入电脑上的最新版本（**会丢掉手机上的改动**，调用方先确认）。 */
  async reloadEditor(): Promise<void> {
    const state = this.getSnapshot()
    const editor = state.editor
    const sessionId = state.sessionId
    if (!editor || !sessionId || editor.reloading) return
    this.setState((s) =>
      s.editor
        ? { ...s, editor: { ...s.editor, reloading: true, conflict: undefined, error: undefined } }
        : s,
    )
    try {
      const caller = getCaller()
      /*
       * 先读 1 个字节拿版本凭据与大小 —— **大小这一眼必读**：
       * 编辑上限只有 256KB，而这份文件可能已经在电脑上被写成几百 MB（AI 追加日志），
       * 不看一眼就 `readAll` 等于把整份大文件拉进手机内存。
       */
      const head = await caller.call('host.file.read', {
        sessionId,
        path: editor.relPath,
        offset: 0,
        length: 1,
      })
      if (head.mtimeMs == null) throw new Error('电脑端没有给出这份文件的版本信息')
      if (head.size > FILE_EDIT_MAX_BYTES) {
        throw new Error(
          `电脑上这份文件已经是 ${formatFileSize(head.size)}，超过手机端编辑上限 ${formatFileSize(FILE_EDIT_MAX_BYTES)}，请在电脑上改。`,
        )
      }
      const { bytes } = await this.readAll(sessionId, editor.relPath)
      const text = decodeUtf8Strict(bytes)
      if (text == null) throw new Error('这份文件现在的编码不是 UTF-8，不能在手机上编辑。')
      const left = applyEolStyle(text, 'lf')
      this.setState((s) =>
        s.editor
          ? {
              ...s,
              editor: {
                ...s.editor,
                draft: left,
                base: left,
                eol: detectEolStyle(text),
                bom: hasUtf8Bom(bytes),
                mtimeMs: head.mtimeMs as number,
                size: bytes.length,
                saving: false,
                reloading: false,
              },
            }
          : s,
      )
    } catch (err) {
      this.setState((s) =>
        s.editor ? { ...s, editor: { ...s.editor, reloading: false, error: messageOf(err) } } : s,
      )
    }
  }

  /** 释放 ObjectURL（不释放 = 每看一张图就多留一份内存）。 */
  private releasePreview(): void {
    const url = this.getSnapshot().preview?.url
    if (url) URL.revokeObjectURL(url)
  }

  /* ───────────────────────────── 下载 ───────────────────────────── */

  /** 保存一份文件到手机（优先系统分享面板，退化浏览器下载）。 */
  async download(name: string, size: number): Promise<void> {
    const { sessionId, relPath } = this.getSnapshot()
    if (!sessionId) return
    const path = joinPath(relPath, name)
    const guard = downloadGuard(size, DOWNLOAD_MAX_BYTES)
    if (guard) {
      this.setState((s) => ({ ...s, notice: guard }))
      return
    }
    this.setState((s) => ({
      ...s,
      error: undefined,
      notice: undefined,
      download: { name, loaded: 0, total: size },
    }))
    try {
      const bytes = await this.readAll(sessionId, path, (loaded) =>
        this.setState((s) => (s.download ? { ...s, download: { ...s.download, loaded } } : s)),
      ).then((result) => result.bytes)
      const saved = await saveBytes(bytes, name, mimeTypeOf(name))
      this.setState((s) => ({
        ...s,
        download: null,
        notice:
          saved === 'shared'
            ? `已交给系统保存「${name}」`
            : saved === 'downloaded'
              ? `已开始下载「${name}」`
              : undefined,
      }))
    } catch (err) {
      this.setState((s) => ({ ...s, download: null, error: messageOf(err) }))
    }
  }

  /* ───────────────────────────── 上传 ───────────────────────────── */

  /**
   * 上传若干文件到**当前目录**（顺序传，一次一个）。
   *
   * 为什么顺序而不是并发：进度条只有一个（手机上「3 个一起传」会让它来回跳），而带宽本来
   * 就被一条 DataChannel 串行化；并发只会让每一份都变慢，还让失败归因变难。
   */
  async upload(files: File[]): Promise<void> {
    const { sessionId, relPath } = this.getSnapshot()
    if (!sessionId || files.length === 0) return
    const caps = connectionStore.getSnapshot().capabilities
    if (!caps.includes(FILE_UPLOAD_CAPABILITY)) {
      this.setState((s) => ({ ...s, notice: '电脑端未授权「文件上传」' }))
      return
    }
    this.setState((s) => ({ ...s, error: undefined, notice: undefined }))

    /*
     * 每个文件的结果先攒在本地，**最后统一落进 state**。
     *
     * 为何不逐个 setState：收尾的 `reload()` 会重新列目录，而列目录会清掉提示
     * （用户自己翻目录时不该看到上一次上传的回声）—— 先写提示就会被它抹掉。
     */
    const notices: string[] = []
    let firstError: string | undefined

    for (const [index, file] of files.entries()) {
      if (file.size > FILE_UPLOAD_MAX_BYTES) {
        notices.push(
          `「${file.name}」${formatFileSize(file.size)}，超过上限 ${formatFileSize(FILE_UPLOAD_MAX_BYTES)}`,
        )
        continue
      }
      this.setState((s) => ({
        ...s,
        upload: { name: file.name, loaded: 0, total: file.size, index: index + 1, count: files.length },
      }))
      let uploadId: string | null = null
      try {
        const caller = getCaller()
        const begin = await caller.call('host.file.write.begin', {
          sessionId,
          dir: relPath,
          name: file.name,
          size: file.size,
        })
        uploadId = begin.uploadId
        let offset = 0
        while (offset < file.size) {
          const slice = file.slice(offset, offset + FILE_CHUNK_BYTES)
          const bytes = new Uint8Array(await slice.arrayBuffer())
          await caller.call('host.file.write.chunk', {
            uploadId,
            offset,
            data: bytesToBase64(bytes),
          })
          offset += bytes.length
          this.setState((s) => (s.upload ? { ...s, upload: { ...s.upload, loaded: offset } } : s))
        }
        const done = await caller.call('host.file.write.finish', { uploadId })
        uploadId = null
        notices.push(
          done.name === file.name
            ? `已上传「${file.name}」`
            : `已上传为「${done.name}」（同名已存在）`,
        )
      } catch (err) {
        // 失败要**主动放弃**：临时文件留在用户项目里比报错更讨厌（而且没人会去清）
        if (uploadId) {
          await getCaller()
            .call('host.file.write.abort', { uploadId })
            .catch(() => undefined)
        }
        if (!firstError) firstError = messageOf(err)
      }
    }
    this.setState((s) => ({ ...s, upload: null }))
    await this.reload()
    this.setState((s) => ({
      ...s,
      upload: null,
      error: firstError,
      notice: notices.length ? notices.join('；') : undefined,
    }))
  }

  /* ───────────────────────────── 内部 ───────────────────────────── */

  /**
   * 读一份文件的全部字节，顺带把**首块**的元信息带回来（类别 / 总大小 / 版本凭据）。
   *
   * 为何要 `head`：那份元信息本来就在首块应答里（`kind` / `mime` / `size` / `mtimeMs`），
   * 只是原来被丢掉了；预览要不要给编辑入口、编辑保存拿什么做冲突校验，都得看它。
   * 丢掉再单独发一次 `stat` 就是白白多一趟网络。
   */
  private async readAll(
    sessionId: string,
    path: string,
    onProgress?: (loaded: number) => void,
  ): Promise<{ bytes: Uint8Array; head: FileReadResult }> {
    const caller = getCaller()
    const parts: Uint8Array[] = []
    let loaded = 0
    let head: FileReadResult | null = null
    for (;;) {
      const chunk = await caller.call('host.file.read', {
        sessionId,
        path,
        offset: loaded,
        length: FILE_CHUNK_BYTES,
      })
      head ??= chunk
      const bytes = base64ToBytes(chunk.data)
      parts.push(bytes)
      loaded += bytes.length
      onProgress?.(loaded)
      if (chunk.eof) break
      if (bytes.length === 0) break // 对端没给 eof 也没给字节 → 防死循环
    }
    const merged = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let at = 0
    for (const part of parts) {
      merged.set(part, at)
      at += part.length
    }
    // 循环至少跑过一次，`head` 必定有值（循环体内的 `??=` 保证了这一点）
    return { bytes: merged, head: head as FileReadResult }
  }
}

/** 拼当前目录与条目名（两端都不自己解析绝对路径）。 */
function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** `Uint8Array` → `ArrayBuffer`（`Blob` 的分片类型在 TS 里要 `ArrayBuffer` 才干净）。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** 保存策略：优先系统分享（iOS 可「存储到文件」），否则浏览器下载。 */
async function saveBytes(bytes: Uint8Array, name: string, mime: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (canShareFiles()) {
    try {
      const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> }
      await nav.share?.({ files: [new File([toArrayBuffer(bytes)], name, { type: mime })] })
      return 'shared'
    } catch (err) {
      // 用户主动取消分享面板不是错误（别接着弹一次下载 —— 那看起来像没听懂他）
      if (err instanceof Error && err.name === 'AbortError') return 'cancelled'
      // 其它失败（能力在调用瞬间变了等）退化到浏览器下载
    }
  }
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mime }))
  triggerDownload(url, name)
  // 延迟释放：立刻 revoke 有可能把刚开始的下载掐断
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return 'downloaded'
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const fileStore = new FilesStore()
