/**
 * FileSheet —— 手机端的「电脑上的文件」面板（§37）。
 *
 * 三层视图（同一个面板，不新开页面）：
 * 1. **目录**：面包屑 + 条目列表（目录点进去、文件点开预览）；
 * 2. **预览**：图片 / 文本 / Markdown 行内看；二进制或超限只给「下载」；
 * 3. **传输**：底部一条进度 + 上传入口（多选）。
 *
 * ## 为什么复用 `.sheet*` 外壳
 *
 * 手机上「从底部升起的一层」只有一种形态（见 `SettingsSheet.css` 文件头）。这里多出的只是
 * **文件行**与**面包屑**两套内部样式，外壳与色彩令牌全部沿用。
 *
 * ## 两处必须置灰（不是「点了报错」）
 *
 * - **链路是中继**：整面板换成一句话说明（与电脑端同一句，来自共享包）；
 * - **电脑端没开这个能力**：同样整面板说明。旧电脑端没有 `host.file.*` 时手机不该点进去
 *   才发现「不支持」。
 *
 * ⚠️ **置灰只是 UI 收敛**（§7-⑪）：真正的拒绝在电脑侧（ACL + 非中继门槛），
 * 所以这里即便被绕过，也换不来一次越权。
 */
import { useEffect, useMemo } from 'react'
import type { MessageFileRef } from 'virlen-remote'
import { useStore, useStoreSelector } from '../../lib/store'
import { fileStore } from '../../store/files'
import { linkStore } from '../../store/link'
import { connectionStore } from '../../store/connection'
import { chatStore } from '../../store/chat'
import Markdown from '../../components/Markdown'
import {
  crumbsOf,
  isTextual,
  percentOf,
  sizeLabel,
  toFileRef,
  workspaceName,
} from '../../lib/files'
import { IconBack, IconClose, IconDownload, IconEdit, IconFolder, IconUpload } from './icons'
import FileIcon from './FileIcon'
import './FileSheet.css'

interface Props {
  sessionId: string
  onClose: () => void
  /**
   * 把当前预览的文件**引用到对话**（§37）：挂到输入框上，发消息时一并带上。
   *
   * 不传 = 没有这个入口（与 `canReference` 两道门一起管住它）；面板不自己存「已引用」——
   * 那是输入区的状态（`Chat.tsx` 的 `pendingFiles`），面板只负责显示与「开关」。
   */
  onReference?: (ref: MessageFileRef) => void
  /** 取消引用（按钮显示「已引用」时再点一下就走它）。 */
  onUnreference?: (path: string) => void
  /** 已经引用过的文件（决定按钮是「引用」还是「已引用」）。 */
  referenced?: readonly MessageFileRef[]
}

export default function FileSheet({
  sessionId,
  onClose,
  onReference,
  onUnreference,
  referenced,
}: Props) {
  const files = useStore(fileStore)
  const link = useStore(linkStore)
  const conn = useStore(connectionStore)
  const session = useStoreSelector(chatStore, (s) => s.sessions.find((x) => x.id === sessionId))

  /*
   * 打开即列根目录；关闭即清空（下次打开不该看到上一次的目录）。
   *
   * ⚠️ 依赖只有 `sessionId`：`fileStore.open()` 会写 state、进而触发重渲染 —— 若把
   * `files.open` 放进依赖，就会出现「打开 → 重渲染 → 再 open」的死循环。
   */
  useEffect(() => {
    fileStore.open(sessionId)
    return () => fileStore.close()
  }, [sessionId])

  /*
   * 门槛判定每次渲染现算（它读的是 linkStore / connectionStore 的快照）。
   * 用 `link.path` 与 `conn.capabilities` 做依赖：这两个变了就够重算了 —— 判定本身仍在
   * store 里（`blockReason`），组件不重写一份口径。
   */
  const blocked = useMemo(() => fileStore.blockReason(), [link.path, conn.capabilities])

  const workspace = session?.workspace ?? files.absPath
  const rootName = useMemo(() => workspaceName(workspace || files.absPath), [workspace, files.absPath])
  const crumbs = useMemo(() => crumbsOf(files.relPath, rootName), [files.relPath, rootName])
  const preview = files.preview

  const busy = fileStore.isBusy()
  /**
   * 能不能编辑 = 电脑端认 `file.edit`（能力位）**且**这份文件本身可编辑
   * （纯文本 / 代码 / Markdown + 合法 UTF-8 + 在编辑上限内 + 电脑侧给了版本凭据）。
   *
   * 两个条件分开看：能力位是「电脑端会不会静默做错事」（旧电脑端会忽略 `overwrite`），
   * 文件那四条是「这份东西该不该在手机上改」。
   */
  const canEdit = !blocked && preview?.editable === true && fileStore.canEdit()
  /*
   * 「引用到对话」（§37）：电脑端认 `message.file`，且调用方真的给了回调。
   *
   * 两道门都是必要的：能力位管「旧电脑端会静默丢掉 `files`」（用户以为附上了，AI 从未看到）；
   * 回调管「这个面板这次是不是在聊天页里打开的」。
   */
  const canReference = !blocked && onReference != null && fileStore.canReference()
  /** 预览的这份文件在协议里的引用体（那个绝对路径要**拼一次、两处用**：显示与开关）。 */
  const previewRef = preview
    ? toFileRef(files.absPath, preview.name, { size: preview.size })
    : null
  const referencedPaths = useMemo(
    () => new Set((referenced ?? []).map((f) => f.path)),
    [referenced],
  )
  const isReferenced = previewRef ? referencedPaths.has(previewRef.path) : false
  const canUpload = !blocked && fileStore.canUpload()
  const progress = files.upload ?? files.download
  const progressLabel = files.upload
    ? `正在上传${files.upload.count && files.upload.count > 1 ? `（${files.upload.index}/${files.upload.count}）` : ''} ${files.upload.name}`
    : files.download
      ? `正在下载 ${files.download.name}`
      : ''

  /**
   * 退出编辑区。有未保存的改动就先问一句（`window.confirm` 是本仓统一的二次确认形态）。
   *
   * 为何必须问：手机上误触「取消」/ 关面板很常见，而**草稿一丢就没了** ——
   * 电脑上那份文件从头到尾没被改过，没有任何地方能把用户刚敲的字找回来。
   */
  const leaveEditor = (): boolean => {
    if (!files.editor) return true
    // 保存 / 重新载入中：先让它跑完（此刻离开会留下一个说不清的状态）
    if (files.editor.saving || files.editor.reloading) return false
    if (fileStore.isDirty() && !window.confirm('这份文件还有未保存的改动，确定放弃？')) return false
    fileStore.cancelEdit()
    return true
  }

  /** 关面板：同样先过一遍「未保存」确认。 */
  const requestClose = (): void => {
    if (!leaveEditor()) return
    onClose()
  }

  return (
    <>
      <div className="sheet__backdrop" onClick={requestClose} />
      <section className="sheet files" role="dialog" aria-label="电脑上的文件">
        <header className="sheet__head">
          <span className="sheet__title">电脑上的文件</span>
          {/*
            进目录 / 刷新时的提示：挂在**标题栏**下（`.files__loading` 是绝对定位）。
            为何不放在列表里：① 放进去要顶高度 —— 那就还是要「动一下」；② 列表滚下去之后
            就看不见它了，而用户翻到下面点目录时恰恰最需要看到反馈。
          */}
          {files.loading && files.entries.length > 0 && (
            <p className="files__loading" role="status">
              <span className="spinner spinner--sm" aria-hidden="true" /> 正在读取目录…
            </p>
          )}
          <button type="button" className="sheet__close" aria-label="关闭" onClick={requestClose}>
            <IconClose />
          </button>
        </header>

        <div className="sheet__body">
          {blocked ? (
            /* 链路 / 能力两道门槛：整面板换成说明，而不是让用户点进去逐条失败 */
            <p className="files__blocked">{blocked}</p>
          ) : (
            <>
              {/* ── 面包屑：点哪一段就跳到哪一级 ── */}
              <nav className="files__crumbs" aria-label="当前目录">
                {crumbs.map((crumb, index) => (
                  <span key={crumb.path || '/'} className="files__crumb-item">
                    {index > 0 && <span className="files__crumb-sep">/</span>}
                    <button
                      type="button"
                      className={`files__crumb${index === crumbs.length - 1 ? ' is-current' : ''}`}
                      disabled={busy || index === crumbs.length - 1}
                      onClick={() => void fileStore.enter(crumb.path)}
                    >
                      {crumb.name}
                    </button>
                  </span>
                ))}
              </nav>

              {files.error && <p className="files__error">{files.error}</p>}
              {files.notice && <p className="files__notice">{files.notice}</p>}

              {files.editor ? (
                /* ── 编辑视图 ── */
                <div className="files__editor">
                  <div className="files__editor-head">
                    <span className="files__editor-name">{files.editor.name}</span>
                    <span className="files__editor-state">
                      {files.editor.saving
                        ? '正在保存…'
                        : files.editor.reloading
                          ? '正在重新载入…'
                          : files.editor.draft === files.editor.base
                            ? '未改动'
                            : '有未保存的改动'}
                    </span>
                  </div>
                  <textarea
                    className="files__editor-text"
                    value={files.editor.draft}
                    onChange={(event) => fileStore.updateDraft(event.target.value)}
                    disabled={files.editor.saving || files.editor.reloading}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    aria-label={`编辑 ${files.editor.name}`}
                  />
                  {files.editor.conflict && (
                    /* 冲突不是「保存失败」：草稿还在，给用户两个明确的选择而不是一个「确定」 */
                    <div className="files__conflict" role="alert">
                      <p className="files__conflict-text">{files.editor.conflict}</p>
                      <div className="files__conflict-actions">
                        <button
                          type="button"
                          className="btn btn--small"
                          disabled={busy}
                          onClick={() => {
                            // 重新载入会丢掉手机上刚敲的字：这一步也必须先问
                            if (!window.confirm('重新载入会丢掉手机上未保存的改动，继续？')) return
                            void fileStore.reloadEditor()
                          }}
                        >
                          重新载入
                        </button>
                        <button
                          type="button"
                          className="btn btn--danger btn--small"
                          disabled={busy}
                          onClick={() => void fileStore.saveEdit(true)}
                        >
                          强制覆盖
                        </button>
                      </div>
                    </div>
                  )}
                  {files.editor.error && <p className="files__error">{files.editor.error}</p>}
                </div>
              ) : preview ? (
                /* ── 预览视图 ── */
                <div className="files__preview">
                  <div className="files__preview-head">
                    <button
                      type="button"
                      className="files__back"
                      aria-label="返回目录"
                      onClick={() => fileStore.closePreview()}
                    >
                      <IconBack />
                    </button>
                    <span className="files__preview-name">{preview.name}</span>
                    <span className="files__preview-size">{sizeLabel(preview.size)}</span>
                    {canEdit && (
                      <button
                        type="button"
                        className="files__edit"
                        disabled={busy}
                        onClick={() => fileStore.startEdit()}
                      >
                        编辑
                      </button>
                    )}
                    {/*
                      「引用到对话」（§37）：与「编辑」并列放在预览头 —— 两者都是
                      「对这个文件做点什么」，而不是传输（传输在底栏）。

                      ⚠️ **点完不关面板**（与上传 / 下载不同）：用户可以接着开下一个文件继续引用，
                      反馈走 toast（输入区被面板遮着，看不到 chip）。已引用时按钮变「已引用」，
                      再点一下 = 取消引用（否则用户得先关面板、再删 chip，多两步还不清楚去哪删）。
                    */}
                    {canReference && previewRef && (
                      <button
                        type="button"
                        className={`files__ref${isReferenced ? ' is-on' : ''}`}
                        disabled={busy}
                        aria-pressed={isReferenced}
                        onClick={() =>
                          isReferenced
                            ? onUnreference?.(previewRef.path)
                            : onReference?.(previewRef)
                        }
                      >
                        {isReferenced ? '已引用' : '引用'}
                      </button>
                    )}
                  </div>

                  {files.previewLoading ? (
                    <p className="files__hint">
                      <span className="spinner spinner--sm" aria-hidden="true" /> 正在读取…
                    </p>
                  ) : preview.url ? (
                    <img className="files__image" src={preview.url} alt={preview.name} />
                  ) : isTextual(preview.kind) && preview.text != null ? (
                    preview.kind === 'markdown' ? (
                      <div className="files__md">
                        <Markdown content={preview.text} />
                      </div>
                    ) : (
                      <pre className="files__text">{preview.text}</pre>
                    )
                  ) : (
                    <p className="files__hint">{preview.reason ?? '这份文件不能在手机上预览。'}</p>
                  )}
                  {/*
                    编辑不了时**只在本该能编的情况下**说明原因（文本类）：
                    对一张 PNG 说「这类文件不能在手机上编辑」只是噪音。
                  */}
                  {!preview.editable && isTextual(preview.kind) && preview.editBlocked && (
                    <p className="files__hint">{preview.editBlocked}</p>
                  )}
                </div>
              ) : files.entries.length > 0 ? (
                /* ── 目录视图 ──
                   进目录 / 刷新时**不清空这份列表**：它留在原地（行本就是 disabled 的，一眼看得出是
                   上一份），等下一份回来直接替换。先清空再填回会让面板高度先塌再撑 —— 真机上的
                   观感就是「闪一下」（用户反馈）。那个「正在读取」的提示在标题栏下，不占这里的高度。 */
                <ul className="files__list" aria-busy={files.loading || undefined}>
                  {files.relPath !== '' && (
                    <li>
                      <button
                        type="button"
                        className="files__row"
                        disabled={busy}
                        onClick={() => void fileStore.up()}
                      >
                        <IconFolder className="files__row-icon" />
                        <span className="files__row-name">..</span>
                      </button>
                    </li>
                  )}
                  {files.entries.map((entry) => {
                    return (
                      <li key={entry.name}>
                        <button
                          type="button"
                          className="files__row"
                          disabled={busy}
                          onClick={() => void fileStore.openEntry(entry)}
                          /* 长名不换行、右侧体积不被挤掉（手机上「名字很长」是常态） */
                          title={entry.name}
                        >
                          <FileIcon name={entry.name} isDir={entry.isDir} className="files__row-icon" />
                          <span className="files__row-name">{entry.name}</span>
                          <span className="files__row-size">
                            {entry.isDir ? '目录' : sizeLabel(entry.size)}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              ) : files.loading ? (
                /* 上一份列表还不存在（刚打开面板）：没东西可留，照旧给一行提示 */
                <p className="files__hint">
                  <span className="spinner spinner--sm" aria-hidden="true" /> 正在读取目录…
                </p>
              ) : (
                <p className="files__hint">这个目录是空的。</p>
              )}

              {files.truncated && <p className="files__hint">条目过多，只显示前一部分。</p>}
            </>
          )}
        </div>

        {/* ── 底部：编辑时是「保存 / 取消」，其它时候是进度 + 两个传输动作 ── */}
        <footer className="files__foot">
          {files.editor ? (
            <div className="files__actions">
              <button
                type="button"
                className="btn btn--primary btn--small"
                disabled={busy}
                onClick={() => void fileStore.saveEdit()}
              >
                {files.editor.saving ? '保存中…' : '保存'}
              </button>
              <button type="button" className="btn btn--small" disabled={busy} onClick={leaveEditor}>
                取消
              </button>
            </div>
          ) : (
            <>
              {progress && (
                <div className="files__progress">
                  <div className="files__progress-text">
                    <span className="files__progress-label">{progressLabel}</span>
                    <span className="files__progress-num">
                      {percentOf(progress.loaded, progress.total)}%
                    </span>
                  </div>
                  <div className="sheet__bar" aria-hidden="true">
                    <span
                      className="sheet__bar-fill"
                      style={{ width: `${percentOf(progress.loaded, progress.total)}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="files__actions">
                <label
                  className={`btn btn--small${canUpload ? '' : ' is-disabled'}`}
                  aria-disabled={!canUpload}
                >
                  <IconUpload />
                  上传到此处
                  <input
                    type="file"
                    multiple
                    className="files__file-input"
                    disabled={!canUpload}
                    onChange={(event) => {
                      const picked = Array.from(event.target.files ?? [])
                      // 清空 value：否则连续选同一个文件不会再触发 change
                      event.target.value = ''
                      if (picked.length) void fileStore.upload(picked)
                    }}
                  />
                </label>

                {preview && (
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy}
                    onClick={() => void fileStore.download(preview.name, preview.size)}
                  >
                    <IconDownload />
                    下载
                  </button>
                )}
              </div>

              {!canUpload && !blocked && (
                <p className="files__hint">传输进行中，或电脑端未授权上传。</p>
              )}
            </>
          )}
        </footer>
      </section>
    </>
  )
}
