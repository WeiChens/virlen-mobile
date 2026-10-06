/**
 * 文件面板的纯函数层（`lib/files.ts`）—— 全是判定，不碰链路、不碰 store。
 *
 * 为什么这些细节值得单测：它们在真机上「错了也不抛错」——
 * 面包屑少一级、图标不对、BOM 显示成一个怪字符、体积文案多一位小数，
 * 都只会让用户觉得「哪里不对」而说不出哪里不对。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DOWNLOAD_MAX_BYTES,
  canShareFiles,
  crumbsOf,
  decodeText,
  downloadGuard,
  fileIconKind,
  parentDir,
  percentOf,
  previewLimit,
  sizeLabel,
  workspaceName,
} from '../lib/files'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('图标类别', () => {
  it('目录 / 图片 / 代码 / 数据 / 文档 / 其它各归一类', () => {
    expect(fileIconKind('src', true)).toBe('dir')
    expect(fileIconKind('logo.PNG', false)).toBe('image')
    expect(fileIconKind('index.tsx', false)).toBe('code')
    expect(fileIconKind('package.json', false)).toBe('data')
    expect(fileIconKind('README.md', false)).toBe('doc')
    expect(fileIconKind('app.bin', false)).toBe('file')
  })

  it('无扩展名 / 前导点的文本文件也算文档（分类与共享包同一张表）', () => {
    // `.gitignore` / `Makefile` 在共享包那一侧就是 `text` → 图标按文档给，而不是「未知文件」
    expect(fileIconKind('.gitignore', false)).toBe('doc')
    expect(fileIconKind('Makefile', false)).toBe('doc')
    expect(fileIconKind('', false)).toBe('file')
  })
})

describe('面包屑与路径', () => {
  it('第一段是工作目录本身，之后逐级累积', () => {
    expect(crumbsOf('', 'virlen-demo')).toEqual([{ name: 'virlen-demo', path: '' }])
    expect(crumbsOf('src/store', 'virlen-demo')).toEqual([
      { name: 'virlen-demo', path: '' },
      { name: 'src', path: 'src' },
      { name: 'store', path: 'src/store' },
    ])
  })

  it('工作目录名取末级（Windows 反斜杠也认），空串有兜底', () => {
    expect(workspaceName('E:/code/virlen-demo')).toBe('virlen-demo')
    expect(workspaceName('E:\\code\\virlen-demo\\')).toBe('virlen-demo')
    expect(workspaceName('')).toBe('工作目录')
  })

  it('上一级：根目录的上一级还是根', () => {
    expect(parentDir('src/store')).toBe('src')
    expect(parentDir('src')).toBe('')
    expect(parentDir('')).toBe('')
  })
})

describe('预览限额与文本解码', () => {
  it('限额直接来自共享包（两端同一张表）', () => {
    expect(previewLimit('text')).toBe(1024 * 1024)
    expect(previewLimit('markdown')).toBe(1024 * 1024)
    expect(previewLimit('image')).toBe(8 * 1024 * 1024)
    expect(previewLimit('binary')).toBe(0)
  })

  it('解码：UTF-8 + 宽容；BOM 去掉（否则首行前面会多个怪字符）', () => {
    const encoder = new TextEncoder()
    expect(decodeText(encoder.encode('第一行\n第二行'))).toBe('第一行\n第二行')
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe('hi')
    // 非法 UTF-8 不抛错（GBK 注释不该让整个预览失败）
    expect(() => decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).not.toThrow()
  })
})

describe('体积文案与进度', () => {
  it('与电脑侧同一套进位（共享包 formatFileSize）', () => {
    expect(sizeLabel(0)).toBe('0 B')
    expect(sizeLabel(1536)).toBe('1.5 KB')
    expect(sizeLabel(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('百分比：总量未知 / 非法时给 0（UI 那时显示不确定态）', () => {
    expect(percentOf(0, 100)).toBe(0)
    expect(percentOf(50, 100)).toBe(50)
    expect(percentOf(100, 100)).toBe(100)
    expect(percentOf(5, 0)).toBe(0)
    expect(percentOf(5, Number.NaN)).toBe(0)
    // 超发不越界（文件在传输期间被改大会走到这里）
    expect(percentOf(200, 100)).toBe(100)
  })
})

describe('本机门槛：下载上限与系统分享能力', () => {
  it('下载上限：超过就给一句人话（含两个体积），而不是抛错', () => {
    expect(downloadGuard(1024)).toBeNull()
    const reason = downloadGuard(DOWNLOAD_MAX_BYTES + 1)
    expect(reason).toContain('64.0 MB')
    expect(reason).toContain('电脑上取用')
  })

  it('系统分享：没有 canShare / share 时一律说「不行」（于是走浏览器下载）', () => {
    vi.stubGlobal('navigator', { userAgent: 'test' })
    expect(canShareFiles()).toBe(false)

    vi.stubGlobal('navigator', {
      userAgent: 'test',
      share: () => Promise.resolve(),
      canShare: () => false,
    })
    expect(canShareFiles()).toBe(false)

    vi.stubGlobal('navigator', {
      userAgent: 'test',
      share: () => Promise.resolve(),
      canShare: () => true,
    })
    expect(canShareFiles()).toBe(true)
  })
})
