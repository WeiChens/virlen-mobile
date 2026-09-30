// @vitest-environment node
/**
 * CSS 层叠契约：**跨文件的同权重覆盖 = 静默失效**。
 *
 * 为什么值得写一个专门的用例：这类缺陷**不报错、不抛异常、类型检查也过**，只在真机上表现为
 * 「某个颜色 / 某个样式不见了」。本仓已经踩过一次 —— 2026-10 真机反馈
 * 「信号图标的黄绿红不见了」，根因是：
 *
 *   `.iconbtn`（基类，`color: var(--fg-3)`）在 `index.css`；五个信号档位
 *   （`.iconbtn--signal-good` …）在 `Chat.css`。两者都是**单类选择器**、权重相同（0,1,0），
 *   于是胜负由**文件先后**决定。而 `main.tsx` 先 `import './App'`（页面样式先入包）、
 *   最后才 import `theme.css` / `index.css` —— 基类排在后面，把档位的 `color` 全盖成灰。
 *
 * 修法不是调 import 顺序（那个顺序另有用途：基类要能压住页面里的装饰性动画，
 * 见 `index.css` 头注释），而是让档位**权重更高且与文件先后无关**：
 * 写成复合选择器 `.iconbtn.iconbtn--signal-good`（0,2,0）。
 *
 * 所以这个用例守的是两条：
 *
 *  1. 同一个单类选择器在**两个文件**里都定义、且改到同一个属性 → 谁赢取决于打包顺序，
 *     迟早出问题（要么合并、要么加权）；
 *  2. 单类**修饰符**（`.x--y`）与它的**基础类**（`.x`）分居两个文件、且改到同一个属性
 *     → 修饰符权重不高于基础类，同样由顺序决定胜负（就是本次的坑）。
 *
 * 属性比较**必须展开简写**：CSS 里的「盖掉」不要求属性同名 —— `.iconbtn` 基础样式里那条
 * `border: 1px solid var(--border-2)` 会把 `border-color` 一并写掉，所以档位即使只写
 * `border-color`（不碰 `color`）也会被它抹掉。只比字面属性名会漏掉这一半。
 *
 * 例外（有意不报）：
 *
 *  - **同一个文件内**基础类与修饰符的先后顺序 —— 那是**故意**的层叠，文件内的书写顺序
 *    就是唯一真相，改起来看得见；
 *  - **`@media` 里的覆盖**（本仓就是 `index.css` 的 `prefers-reduced-motion` 那段：
 *    `animation: none` / `transition: none`）—— 那是一个**有条件的关掉**策略块，
 *    集中写在一处才看得见全貌。它靠的是「`index.css` 留在包尾」，这条顺序另有用例管
 *    （见文件末尾「main.tsx 的 import 顺序」）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 样式表根目录（`src/`）。 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface Rule {
  /** 相对 `src/` 的路径（正斜杠），仅用于报错信息。 */
  file: string
  /** 逗号选择器已拆开。 */
  selectors: string[]
  /** 声明的属性名（小写；自定义属性 `--x` 已剔除 —— 那是令牌定义，不是覆盖）。 */
  props: string[]
  /** 是否写在 `@media` / `@keyframes` 这类 at-rule 块内（= 有条件才生效）。 */
  conditional: boolean
}

export interface Conflict {
  token: string
  files: string[]
  props: string[]
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 极简 CSS 规则解析（够用就好，不引 parser）：
 * 按花括号配对切出每条规则；`@media` / `@keyframes` 一律**递归进块内**继续收
 * （关键帧里的 `0%` / `to` 不是单类选择器，收了也不参与判定）。
 */
export function parseRules(file: string, css: string, conditional = false): Rule[] {
  const text = stripComments(css)
  const out: Rule[] = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open < 0) break
    let depth = 1
    let j = open + 1
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') depth--
      j++
    }
    // `@import …;` 之后紧跟的规则会被切进同一个 prelude → 取最后一个 `;` 之后的部分
    const raw = text.slice(i, open)
    const prelude = raw.slice(raw.lastIndexOf(';') + 1).trim()
    const body = text.slice(open + 1, j - 1)
    if (prelude.startsWith('@')) {
      out.push(...parseRules(file, body, true))
    } else if (prelude) {
      out.push({
        file,
        conditional,
        selectors: prelude
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        props: body
          .split(';')
          .map((d) => (d.split(':')[0] ?? '').trim().toLowerCase())
          .filter((p) => p !== '' && !p.startsWith('--')),
      })
    }
    i = j
  }
  return out
}

/** 只有「单个类选择器」（`.foo`）才有同权重风险：`.a.b` / 后代 / 伪类 / 标签一律不算。 */
function singleClass(selector: string): string | null {
  return /^\.[A-Za-z0-9_-]+$/.test(selector) ? selector : null
}

/** 修饰类 `.x--y` → 基础类 `.x`（不是修饰类则返回 `null`）。 */
function baseOf(token: string): string | null {
  const i = token.indexOf('--')
  return i > 1 ? token.slice(0, i) : null
}

/**
 * 简写属性 → 它实际会写到的 longhand（只列本仓会用到的那些，不求全）。
 *
 * 为什么必须有这张表：`.iconbtn` 的 `border: 1px solid …` 会把 `border-color` 一起写掉，
 * 而档位通常只改 `border-color` —— 只比属性字面名会漏报。
 */
const SHORTHAND: Record<string, string[]> = (() => {
  const sides = ['top', 'right', 'bottom', 'left']
  const box = ['width', 'style', 'color']
  const border: string[] = ['border-width', 'border-style', 'border-color']
  for (const s of sides) for (const b of box) border.push(`border-${s}-${b}`)
  const map: Record<string, string[]> = {
    border,
    background: ['background-color', 'background-image', 'background-position', 'background-size'],
    font: ['font-style', 'font-weight', 'font-size', 'line-height', 'font-family'],
    transition: ['transition-property', 'transition-duration', 'transition-delay'],
    animation: ['animation-name', 'animation-duration', 'animation-delay', 'animation-iteration-count'],
    margin: sides.map((s) => `margin-${s}`),
    padding: sides.map((s) => `padding-${s}`),
    inset: ['top', 'right', 'bottom', 'left'],
    gap: ['row-gap', 'column-gap'],
    overflow: ['overflow-x', 'overflow-y'],
    flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
    'border-radius': sides.map((s) => `border-${s}-radius`),
  }
  for (const s of sides) map[`border-${s}`] = box.map((b) => `border-${s}-${b}`)
  return map
})()

/** 一个声明实际会写到的所有属性（自己 + 简写展开）。 */
function writes(prop: string): string[] {
  return [prop, ...(SHORTHAND[prop] ?? [])]
}

/**
 * 两批声明里「实际会互相盖掉」的属性名（双侧声明名都算上，便于一眼看出是哪两条在打架）。
 *
 * 判据是**展开后**是否相交：`border` 与 `border-color` 相撞（简写写掉了后者），
 * 而 `border` 与 `border-radius` 不相撞（前者不管圆角）。
 */
function overlap(a: Iterable<string>, b: Iterable<string>): string[] {
  const bWrites = new Set<string>()
  for (const p of b) for (const q of writes(p)) bWrites.add(q)
  const hit = new Set<string>()
  for (const p of a) {
    if (writes(p).some((q) => bWrites.has(q))) hit.add(p)
  }
  const aWrites = new Set<string>()
  for (const p of a) for (const q of writes(p)) aWrites.add(q)
  for (const p of b) {
    if (writes(p).some((q) => aWrites.has(q))) hit.add(p)
  }
  return [...hit].sort()
}

export function findConflicts(rules: Rule[]): Conflict[] {
  // token → 文件 → 该文件里为它声明过的属性。
  // 只收**无条件生效**的规则：`@media` 里的覆盖是有条件层（见文件头注释的例外说明）。
  const where = new Map<string, Map<string, Set<string>>>()
  for (const rule of rules) {
    if (rule.conditional) continue
    for (const selector of rule.selectors) {
      const token = singleClass(selector)
      if (!token) continue
      const perFile = where.get(token) ?? new Map<string, Set<string>>()
      const props = perFile.get(rule.file) ?? new Set<string>()
      for (const p of rule.props) props.add(p)
      perFile.set(rule.file, props)
      where.set(token, perFile)
    }
  }

  const out: Conflict[] = []
  for (const [token, perFile] of where) {
    const files = [...perFile.keys()]
    // ① 同一个类跨文件定义，且改到同一个属性（含简写展开）
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const shared = overlap(perFile.get(files[i])!, perFile.get(files[j])!)
        if (shared.length) out.push({ token, files: [files[i], files[j]], props: shared })
      }
    }
    // ② 单类修饰符 vs 它的基础类，分居两个文件
    const base = baseOf(token)
    const basePerFile = base ? where.get(base) : undefined
    if (!basePerFile) continue
    for (const [baseFile, baseProps] of basePerFile) {
      for (const [modFile, modProps] of perFile) {
        if (baseFile === modFile) continue
        const shared = overlap(modProps, baseProps)
        if (shared.length) out.push({ token, files: [modFile, baseFile], props: shared })
      }
    }
  }
  return out
}

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) cssFiles(full, out)
    else if (name.endsWith('.css')) out.push(relative(SRC, full).replace(/\\/g, '/'))
  }
  return out
}

const NAMES = cssFiles(SRC)
const RULES = NAMES.flatMap((f) => parseRules(f, readFileSync(join(SRC, f), 'utf8')))

describe('CSS 层叠契约（跨文件同权重覆盖 = 静默失效）', () => {
  it('检测器本身有效：合成一对「修饰符 vs 基础类」必须被抓出来（含简写展开）', () => {
    const conflicts = findConflicts([
      // 基础类照抄本次缺陷里的真实写法：`border` 简写会把 `border-color` 一并写掉
      ...parseRules('index.css', '.iconbtn { color: red; border: 1px solid blue }'),
      // 本次真机缺陷的写法（单类修饰符、基础类在另一个文件、同改 color / border-color）
      ...parseRules(
        'ui/pages/Chat.css',
        '.iconbtn--signal-good { color: green; border-color: lime }',
      ),
    ])
    expect(conflicts).toEqual([
      {
        token: '.iconbtn--signal-good',
        files: ['ui/pages/Chat.css', 'index.css'],
        props: ['border', 'border-color', 'color'],
      },
    ])
  })

  it('检测器不会误报：复合选择器 / 同文件内的先后顺序 / 不相干的简写（border vs border-radius）都不算', () => {
    const conflicts = findConflicts([
      ...parseRules('index.css', '.iconbtn { color: red; border: 1px solid blue }'),
      ...parseRules('ui/pages/Chat.css', '.iconbtn.iconbtn--signal-good { color: green }'),
      // `border` 不管圆角 —— 只改 border-radius 的修饰符不算被它盖掉
      ...parseRules('ui/pages/Another.css', '.iconbtn--round { border-radius: 99px }'),
      // 同文件内：基础类在前、修饰符在后 —— 文件内顺序就是有意为之的层叠
      ...parseRules('ui/pages/Other.css', '.msg { color: blue } .msg--user { color: white }'),
    ])
    expect(conflicts).toEqual([])
  })

  it(`真实样式表（${NAMES.length} 个文件 / ${RULES.length} 条规则）没有跨文件同权重覆盖`, () => {
    expect(findConflicts(RULES)).toEqual([])
  })

  it('`@media` 里的覆盖不算冲突 —— 但代价是 index.css 必须留在包尾（见下一条）', () => {
    // 只有这段被跳过才说明「有条件层不进判定」这条豁免真的生效了（否则上面那条会报它）
    const conditional = RULES.filter((r) => r.conditional)
    expect(conditional.length).toBeGreaterThan(0)
    expect(conditional.some((r) => r.file === 'index.css' && r.props.includes('animation'))).toBe(true)
  })

  it('信号档位一律走复合选择器（本次缺陷的定点回归）', () => {
    const chatCss = readFileSync(join(SRC, 'ui/pages/Chat.css'), 'utf8')
    for (const tone of ['good', 'relay', 'warn', 'down', 'plain']) {
      expect(chatCss).toContain(`.iconbtn.iconbtn--signal-${tone}`)
    }
  })

  it('main.tsx 的最后两条 import 是 theme.css → index.css（基类压住页面样式、reduced-motion 生效都靠它）', () => {
    const lines = readFileSync(join(SRC, 'main.tsx'), 'utf8').split(/\r?\n/)
    const imports = lines.filter((l) => /^import\s/.test(l)).map((l) => l.trim())
    expect(imports.slice(-2)).toEqual(["import './theme.css'", "import './index.css'"])
  })
})
