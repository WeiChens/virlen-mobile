/**
 * Chat store —— 会话列表 / 消息 / 运行时状态（手机侧缓存）。
 *
 * 事件驱动：挂上 host 事件后，`message.*` / `runtime.changed` 直接更新缓存，
 * UI 只读 store（不做乐观更新，见 docs/phone-control-bridge.md §5.2）。
 * 流式走独立通道 `message.stream`，以 `streaming` 单独承载；
 * **二期（§32）起电脑侧按本端 `hello` 的声明发增量帧**（`mode='delta'` + `offset`），
 * 本 store 负责拼成完整正文（含重复段剔除、缺口拉全文对齐）。
 */
import {
  BridgeError,
  COMPRESS_MODE_CAPABILITY,
  MESSAGE_DELETE_CAPABILITY,
  type AgentOptionDTO,
  type AnswerAction,
  type CompressMode,
  type ContextInfoDTO,
  type Endpoint,
  type HostEvents,
  type InteractionDTO,
  type MessageDTO,
  type MessageFileRef,
  type MessageQuote,
  type ModelProviderDTO,
  type RunningToolDTO,
  type SessionSummaryDTO,
  type WorkspaceOptionDTO,
} from 'virlen-remote'
import { Store } from '../lib/store'
import { dedupeMessages, insertionIndexFor } from '../lib/messages'
import { getCaller, onEndpointReady } from '../api/active'

export interface StreamingState {
  messageId: string
  text: string
  seq: number
}

export interface ChatState {
  sessions: SessionSummaryDTO[]
  currentSessionId: string | null
  messages: Record<string, MessageDTO[]>
  working: Record<string, boolean>
  /** 会话是否处于「暂停运行」（一般由「暂存」导致）—— 手机据此显示「继续」（M5）。 */
  paused: Record<string, boolean>
  /** 是否正在压缩上下文（电脑侧 `RuntimeDTO.compacting`，手机据此显示进度）。 */
  compacting: Record<string, boolean>
  /**
   * 正在生成的工具调用进度（电脑侧 `RuntimeDTO.toolProgress`，§27）。
   *
   * 引擎在**累积工具参数**期间不发任何事件（长参数可达数十秒），这个字段让「工作中」
   * 有具体内容（「正在生成工具调用 write_file · 1.2k 字符…」），而不是让用户对着不动的
   * 正文以为卡死。只带工具名与已累积字符数，**不含参数内容**。
   */
  toolProgress: Record<string, { name: string; chars: number } | undefined>
  /**
   * **正在执行中**的工具（电脑侧 `RuntimeDTO.runningTools`）。
   *
   * 为何需要：工具的输出要等跑完才作为消息下发，而 `toolProgress` 只管「模型在生成这次
   * 工具调用的参数」那一段 —— 两者之间（工具真的在跑）过去在本端是**全黑**的，用户只看到
   * 「正在思考…」以为卡死。现在这个切片让尾部能列出「正在执行 read_file · src/store/chat.ts」。
   *
   * ⚠️ 权威在电脑侧（字段缺席 = 此刻没有执行中的工具 → 本端清空）；里面只有工具名与一行
   * **入参摘要**，没有输出、也没有百分比。
   */
  runningTools: Record<string, RunningToolDTO[] | undefined>
  /**
   * 各会话最近一次的**电脑侧错误**（`RuntimeDTO.error`，随 `runtime.changed` 下发）。
   *
   * ⚠️ 与上面的 `error` 是**两回事**，别看错：
   * - `error`：**本端**（手机）请求失败 / 链路报错的瞬时提示；
   * - `sessionError`：**电脑侧**的会话说出来的话 —— 引擎跑挂（API 401 / 上下文超限 /
   *   工具报错）时，电脑把原因写进会话运行时并推下来。它属于**会话的状态**，
   *   打开会话就该看到（不是只在那一次推送时闪一下）。
   *
   * 字段缺失 = 电脑侧那边已经没有这条错误（用户在电脑上关掉了 / 重新发送时清了）。
   */
  sessionError: Record<string, string | undefined>
  /**
   * 已被用户点掉的那条错误**文本**（会话 → 文本）：同一个错误不重复弹。
   *
   * 为何按文本而不是布尔：手机**不能**清电脑侧的错误（协议里没有这条 RPC），本地「知道了」
   * 只对**那一条**生效 —— 而电脑侧的运行时快照会一遍遍补推（每次重开这个会话都会带回来）。
   * 布尔标记会让同一句话永远弹不出来；按文本比对时，换一条**不同**的错误立刻重新出现
   * （电脑侧先清后报时，`applyEvent` 还会主动把这个标记撤掉，见那里的注释）。
   */
  dismissedError: Record<string, string | undefined>
  /** 各会话的上下文占用（快照 `host.session.context` + 增量 `context.changed`）。 */
  context: Record<string, ContextInfoDTO | undefined>
  streaming: Record<string, StreamingState | undefined>
  /** 是否还有更早的消息可加载（M5 分页）。 */
  hasMoreMessages: Record<string, boolean>
  /** 更早消息的**不透明游标**（电脑侧原样回传，手机不解析其数值语义，见 §20.2-A）。 */
  cursor: Record<string, number | null>
  /** 正在加载更早消息。 */
  loadingOlder: boolean
  /** 待应答交互（提问 / 授权）—— 电脑侧权威，本地只是一份投影（M4）。 */
  interactions: InteractionDTO[]
  loadingSessions: boolean
  loadingMessages: boolean
  error?: string
  /** 一次性提示（如「该请求已在电脑上处理」）—— 不弹错，只告知。 */
  notice?: string
  // ── §22：模型 / 工作目录 / 上下文 ──
  /** 电脑侧已启用的模型服务与模型（白名单：不含 apiKey / baseUrl）。 */
  models: ModelProviderDTO[]
  loadingModels: boolean
  /** 新建会话可选的工作目录（**候选集由电脑侧给出**，手机不能自造）。 */
  workspaces: WorkspaceOptionDTO[]
  loadingWorkspaces: boolean
  /**
   * 新建会话可选的 Agent（候选集同样由电脑侧给出；受 `session.agent` 能力门控）。
   *
   * 旧电脑端没有 `host.agent.list` → 此数组恒为空、`NewChatPanel` 也不渲染这一节
   * （能力驱动显隐，§3.5「没有的东西不显示」）。
   */
  agents: AgentOptionDTO[]
  loadingAgents: boolean
  /**
   * 「新对话」的本地选择（尚未在电脑侧创建任何会话）。
   *
   * ⚠️ 用户拍板：点「新对话」**不**创建会话 —— 只在发送第一条消息时才创建（§22.3）。
   * 所以这组选择必须先活在手机内存里，`draft` 就是它。
   */
  draft: DraftSelection
}

/** 「新对话」的几项选择（Agent / 模型服务 / 模型 / 工作目录；缺省 = 由电脑侧默认值决定）。 */
export interface DraftSelection {
  /**
   * 归属 Agent（缺省 = 电脑侧默认 Agent）。
   *
   * ⚠️ 与桌面同语义（`chat-view.tsx` 的 `selectedAgentId`）：**换 Agent 会清掉模型与工作目录**，
   * 让所选 Agent 的默认值生效 —— 否则会出现「换了代码评审员，却还用着上一个 Agent 挑的模型」
   * 这种当事人都解释不清的组合。
   */
  agentId?: string
  providerConfigId?: string
  modelId?: string
  workspace?: string
}

const INITIAL: ChatState = {
  sessions: [],
  currentSessionId: null,
  messages: {},
  working: {},
  paused: {},
  compacting: {},
  toolProgress: {},
  runningTools: {},
  sessionError: {},
  dismissedError: {},
  context: {},
  streaming: {},
  hasMoreMessages: {},
  cursor: {},
  loadingOlder: false,
  interactions: [],
  loadingSessions: false,
  loadingMessages: false,
  models: [],
  loadingModels: false,
  workspaces: [],
  loadingWorkspaces: false,
  agents: [],
  loadingAgents: false,
  draft: {},
}

/** 应答被拒时的中文提示（`reason` 是协议字段，不直接展示给用户）。 */
const ANSWER_NOTICE: Record<string, string> = {
  'not-found': '该请求已在电脑上处理（或已失效）',
  'already-settled': '该请求已在电脑上处理',
  'confirm-required': '这是高风险操作，需要二次确认后才能批准',
  'invalid-value': '选择内容不能为空',
  'unsupported-by-host': '电脑端不支持该操作',
}

class ChatStore extends Store<ChatState> {
  /**
   * 电脑侧声明的能力集（hello 协商结果）。
   *
   * 为何要在 store 里存一份：PWA **总是最新的**，而电脑端可能还是旧版本 ——
   * 旧电脑没有 `session.model` 等能力时，本 store 里的新方法必须**静静地什么都不做**，
   * 而不是发一个注定 `E_DENIED` 的请求、把错误条顶到界面上（§3.5「能力驱动显隐」）。
   */
  private capabilities: string[] = []

  /**
   * 上下文事件序号（每会话）—— 用于丢弃**比事件更旧的快照响应**，不是 UI 状态。
   *
   * 为何必需（2026-09-29 实测）：`host.session.context` 的快照值是在电脑侧**处理请求那一刻**算的，
   * 而响应可能比一个后续事件更晚到达（电脑侧同样会把那个事件推过来）—— 于是「旧快照覆盖新事件」，
   * 手机上的占用百分比会莫名其妙地回退。与 `refreshInteractions` 里「快照不得覆盖更新的本地条目」
   * 是同一条纪律，只是这里用计数器（不受时钟精度影响）。
   */
  private contextEventSeq: Record<string, number> = {}

  /**
   * 交互在本机的**到达时刻**（interactionId → 本机 ms）——供 `refreshInteractions` 的合并规则用。
   *
   * 为何不用电脑侧给的 `InteractionDTO.createdAt`：那是**电脑的时钟**，与本机 `Date.now()`
   * 不同源。手机时钟快一点就会把**刚推到的卡片**判成「比快照旧」而删掉（真机表现：
   * 问题正在等应答，手机上却什么都没有）；反过来则僵尸卡片永远清不掉。
   * 与 `contextEventSeq`（「计数器不受时钟精度影响」）是同一条纪律。
   */
  private interactionArrivedAt = new Map<string, number>()

  /**
   * 正在进行的「拉全文对齐」（§32）—— 键是 `会话\u0001消息`。
   *
   * 为何要去重：流式期间可能**连续**收到接不上的增量（比如刚重订阅就迎来一批旧帧），
   * 不去重就会对着同一个消息并发发好几次 `host.session.message.get`，白白占带宽。
   */
  private resyncingStreams = new Set<string>()

  /**
   * 已经报过「窗口含重复 id」的会话 —— 每会话只报一次（见 `normalizeWindow`）。
   *
   * 这是**诊断**而不是状态：重复 id 是电脑侧数据的问题（本机已去重），报在控制台给开发/排查用，
   * 不弹给用户 —— 用户什么也做不了，弹一个对话框只会吓人。
   */
  private dupWarned = new Set<string>()

  constructor() {
    super(INITIAL)
  }

  /** 连接就绪 / 断开时由 `connectionStore` 注入（空数组 = 未知，一律不发新请求）。 */  setCapabilities(capabilities: readonly string[]): void {
    this.capabilities = [...capabilities]
  }

  private can(capability: string): boolean {
    return this.capabilities.includes(capability)
  }

  reset(): void {
    this.capabilities = []
    this.contextEventSeq = {}
    this.interactionArrivedAt.clear()
    this.dupWarned.clear()
    this.setState({ ...INITIAL })
  }

  /**
   * 把电脑侧给的**窗口级数据**归一化（按 id 去重）—— `openSession` / `loadOlder` 共用的唯一入口。
   *
   * 为何要在这里做（而不是只靠合并时判重）：本地两条写入通道（`message.added` 按 id 判重、
   * `loadOlder` 按 `known` 过滤）只能挡住「与本地重复」，**挡不住电脑侧那一页自带重复**。
   * 而重复 id 会直接弄坏列表：重复 key 会让 React 报 `Encountered two children with the same key`，
   * 也会让折叠态张冠李戴（二者都按行的 key 记账）。
   * 详细来源分析见 `lib/messages.ts::dedupeMessages`。
   */
  private normalizeWindow(sessionId: string, incoming: readonly MessageDTO[]): MessageDTO[] {
    const unique = dedupeMessages(incoming)
    if (unique.length === incoming.length || this.dupWarned.has(sessionId)) return unique
    this.dupWarned.add(sessionId)
    console.warn(
      `[virlen] 电脑侧下发的消息窗口含重复 id：会话 ${sessionId} 的 ${incoming.length} 条里有 ` +
        `${incoming.length - unique.length} 条重复，已在本机去重（保留先出现的那一条）。\n` +
        '重复的 key 会让 React 报错、并让折叠态张冠李戴。\n' +
        '请在电脑侧检查窗口合并：`sessionStore.loadOlderMessages` 的前插（它没有按 id 去重）。',
    )
    return unique
  }

  /** 收起一次性提示（如「该请求已在电脑上处理」）。 */
  clearNotice(): void {
    this.setState((s) => ({ ...s, notice: undefined }))
  }

  /**
   * 收起当前会话的错误提示（**只作用于本端**）。
   *
   * 为何不发 RPC 去清电脑侧：协议里没有「清除会话错误」的方法，而且这条错误的权威在电脑侧
   * ——用户可能已经在电脑上点掉了，或者重新发送时被清掉（那时会推一帧不带 `error` 的运行时），
   * 本地缓存会跟着清。所以这里只记「这条文本我读过了」。
   */
  dismissSessionError(sessionId: string): void {
    const text = this.getSnapshot().sessionError[sessionId]
    if (!text) return
    this.setState((s) => ({
      ...s,
      dismissedError: { ...s.dismissedError, [sessionId]: text },
    }))
  }

  async loadSessions(): Promise<void> {
    this.setState((s) => ({ ...s, loadingSessions: true, error: undefined }))
    try {
      const { sessions } = await getCaller().call('host.session.list', {})
      this.setState((s) => ({
        ...s,
        sessions,
        loadingSessions: false,
        // 「新对话」的默认选择：首次拿到列表时用**最近一个会话**的模型 / 目录（
        // 与桌面「上次用什么，新建就默认用什么」同思路）；用户显式改过就不再覆盖
        draft: s.draft.providerConfigId || s.draft.workspace || s.draft.agentId ? s.draft : seedDraft(sessions),
      }))
    } catch (err) {
      this.setState((s) => ({ ...s, loadingSessions: false, error: messageOf(err) }))
    }
  }

  /** 进入「新对话」：**不创建任何东西**（发送第一条消息时才创建）。 */
  newChat(): void {
    this.setState((s) => ({ ...s, currentSessionId: null, error: undefined, notice: undefined }))
  }

  /** 切换模型：有会话 → 电脑侧（桌面 model-switcher 等价）；无会话 → 只改本地草稿。 */
  async setModel(providerConfigId: string, modelId: string): Promise<void> {
    const sessionId = this.getSnapshot().currentSessionId
    if (!sessionId) {
      this.setState((s) => ({ ...s, draft: { ...s.draft, providerConfigId, modelId } }))
      return
    }
    // 旧版本电脑没有该能力：UI 本就不会显示选择器，这里是纵深防御
    if (!this.can('session.model')) return
    try {
      await getCaller().call('host.session.setModel', { sessionId, providerConfigId, modelId })
      await this.loadSessions()
    } catch (err) {
      this.setState((s) => ({ ...s, error: messageOf(err) }))
    }
  }

  /** 选定「新对话」的工作目录（只在无会话时可用；已有会话的工作目录不可改）。 */
  setDraftWorkspace(workspace: string): void {
    this.setState((s) => ({ ...s, draft: { ...s.draft, workspace } }))
  }

  /**
   * 选定「新对话」的 Agent（只在无会话时可用）。
   *
   * 换 Agent **一并清掉模型与工作目录**（只留 `agentId`）—— 让所选 Agent 的默认值生效，
   * 与桌面 `chat-view` 那条 effect 同语义。重复选同一个 = 无操作（不抹掉用户已经挑好的值）。
   */
  setDraftAgent(agentId: string | undefined): void {
    this.setState((s) => (s.draft.agentId === agentId ? s : { ...s, draft: agentId ? { agentId } : {} }))
  }

  /** 拉取可切换的模型（白名单投影；已缓存时直接返回，`force` 可刷新）。 */
  async loadModels(force = false): Promise<void> {
    if (!this.can('session.model')) return
    const snapshot = this.getSnapshot()
    if (!force && (snapshot.models.length > 0 || snapshot.loadingModels)) return
    this.setState((s) => ({ ...s, loadingModels: true }))
    try {
      const { providers } = await getCaller().call('host.model.list', {})
      this.setState((s) => ({ ...s, models: providers, loadingModels: false }))
    } catch (err) {
      this.setState((s) => ({ ...s, loadingModels: false, error: messageOf(err) }))
    }
  }

  /** 拉取「新建会话可选的工作目录」（候选集由电脑侧给出）。 */
  async loadWorkspaces(force = false): Promise<void> {
    if (!this.can('session.workspace')) return
    const snapshot = this.getSnapshot()
    if (!force && (snapshot.workspaces.length > 0 || snapshot.loadingWorkspaces)) return
    this.setState((s) => ({ ...s, loadingWorkspaces: true }))
    try {
      const { workspaces } = await getCaller().call('host.workspace.list', {})
      this.setState((s) => ({
        ...s,
        workspaces,
        loadingWorkspaces: false,
        // 草稿目录必须仍是候选集内的值：电脑侧删了会话 / 改了设置后，旧选择可能已不存在
        draft: s.draft.workspace && !workspaces.some((w) => w.path === s.draft.workspace)
          ? { ...s.draft, workspace: workspaces[0]?.path }
          : s.draft,
      }))
    } catch (err) {
      this.setState((s) => ({ ...s, loadingWorkspaces: false, error: messageOf(err) }))
    }
  }

  /**
   * 拉取「新建会话可选的 Agent」（候选集由电脑侧给出）。
   *
   * 与 `loadWorkspaces` 同一条纪律：草稿里的 `agentId` 必须仍在候选集内 ——
   * 电脑侧删掉那个 Agent 后，旧选择会变成一条注定 `E_BAD_REQUEST` 的请求。
   * 这里**直接清空**（回落电脑侧默认 Agent），而不是随便挑一个顶上：
   * 静默换成另一个 Agent 比让用户重选一次危险得多。
   */
  async loadAgents(force = false): Promise<void> {
    if (!this.can('session.agent')) return
    const snapshot = this.getSnapshot()
    if (!force && (snapshot.agents.length > 0 || snapshot.loadingAgents)) return
    this.setState((s) => ({ ...s, loadingAgents: true }))
    try {
      const { agents } = await getCaller().call('host.agent.list', {})
      this.setState((s) => ({
        ...s,
        agents,
        loadingAgents: false,
        draft:
          s.draft.agentId && !agents.some((a) => a.id === s.draft.agentId)
            ? { ...s.draft, agentId: undefined }
            : s.draft,
      }))
    } catch (err) {
      this.setState((s) => ({ ...s, loadingAgents: false, error: messageOf(err) }))
    }
  }

  /**
   * 拉取上下文占用快照（打开会话 / 重连后；之后由 `context.changed` 增量维护）。
   *
   * ⚠️ 快照会被**更晚到达的更新事件**抛弃：拉取期间若有推送到达，这份快照就是旧的
   * （值在电脑侧处理请求那一刻算的），应用它会把新占用覆盖回去（见 `contextEventSeq`）。
   */
  async loadContext(sessionId: string): Promise<void> {
    if (!this.can('session.context')) return
    const seq = this.contextEventSeq[sessionId] ?? 0
    try {
      const context = await getCaller().call('host.session.context', { sessionId })
      if ((this.contextEventSeq[sessionId] ?? 0) !== seq) return
      this.setState((s) => ({ ...s, context: { ...s.context, [sessionId]: context } }))
    } catch {
      /* 快照失败不弹错：事件通道若活着，占用照样会到 */
    }
  }

  /**
   * 压缩上下文（**不可逆**：历史会被摘要替换）。
   *
   * RPC 只回投递确认 —— 进度看 `compacting`，结果看 `messages.reset`（重拉窗口）+ 摘要消息。
   * 调用方（UI）负责先弹二次确认，且传 `confirm: true`（电脑侧独立校验，缺了会拒）。
   *
   * @param mode 压缩方式（`ai` = AI 摘要 / `raw` = 正文压缩）。
   *   ⚠️ **只在电脑端声明 `COMPRESS_MODE_CAPABILITY` 时才会被发出去**：旧电脑端不认这个字段，
   *   参数会被静默丢弃、然后按电脑侧设置压缩（用户以为选了正文压缩，实际走的是 AI 摘要、还花了钱）。
   *   不传 = 沿用电脑侧设置里的那一档（与改动前完全同形的一次调用）。
   * @returns 是否被电脑侧接受
   */
  async compressContext(sessionId: string, mode?: CompressMode): Promise<boolean> {
    if (!this.can('session.compress')) return false
    try {
      await getCaller().call('host.session.compress', {
        sessionId,
        confirm: true,
        ...(mode && this.can(COMPRESS_MODE_CAPABILITY) ? { mode } : {}),
      })
      return true
    } catch (err) {
      this.setState((s) => ({ ...s, error: messageOf(err) }))
      return false
    }
  }

  /**
   * 进入会话：**先订阅、再拉快照**，返回时订阅已在电脑侧生效。
   *
   * 顺序不能反（2026-09-29 真机缺陷，§24）：「拉快照 → 订阅」之间存在一个窗口，
   * 窗口内产生的消息事件会被电脑侧的订阅门拦掉且**永不再补** → 界面停在一份过期快照上。
   * 反过来（订阅在前）最多是重复一条消息，而 `message.added` 按 id 幂等。
   *
   * 必须 `await` 到订阅应答：电脑侧是在应答之前完成登记的（`host-source.subscribe` 里
   * `await activateSession` 之后才 `subscriptions.add`），所以「返回即可发送」是有保证的。
   */
  async openSession(sessionId: string): Promise<void> {
    this.setState((s) => ({ ...s, currentSessionId: sessionId, loadingMessages: true }))
    // 订阅先发出去（与快照**并行**，不额外多一个 RTT）；失败不弹错 —— 真有问题时下面的快照
    // 拉取会报得更准（会话不存在 → `E_NOT_FOUND`）
    let subscribed: Promise<unknown> = Promise.resolve()
    try {
      subscribed = getCaller()
        .call('host.session.subscribe', { sessionId })
        .catch(() => {})
      const page = await getCaller().call('host.session.messages', { sessionId })
      const loaded = this.normalizeWindow(sessionId, page.messages)
      this.setState((s) => ({
        ...s,
        messages: { ...s.messages, [sessionId]: loaded },
        hasMoreMessages: { ...s.hasMoreMessages, [sessionId]: page.hasMore },
        cursor: { ...s.cursor, [sessionId]: page.cursor ?? null },
        loadingMessages: false,
      }))
      // 上下文占用快照（之后由 `context.changed` 增量维护）
      void this.loadContext(sessionId)
    } catch (err) {
      this.setState((s) => ({ ...s, loadingMessages: false, error: messageOf(err) }))
    }
    // 一期以「重连后快照重同步」兜底，不做增量续传；但订阅必须在返回前落地（见上方注释）
    await subscribed
  }

  /**
   * 电脑侧把该会话的消息**整体替换**了（压缩 / 删除消息）→ 本地窗口作废并重拉。
   *
   * 为何不逐条对账：压缩会把整段历史换成一条 summary，本地那份已经没有任何意义；
   * 重拉快照天然幂等（与重连后的 `resync` 同一策略）。非当前会话只丢缓存，下次打开再拉。
   */
  async reloadMessages(sessionId: string): Promise<void> {
    this.setState((s) => {
      const messages = { ...s.messages }
      const hasMoreMessages = { ...s.hasMoreMessages }
      const cursor = { ...s.cursor }
      const streaming = { ...s.streaming }
      delete messages[sessionId]
      delete hasMoreMessages[sessionId]
      delete cursor[sessionId]
      delete streaming[sessionId]
      return { ...s, messages, hasMoreMessages, cursor, streaming }
    })
    if (this.getSnapshot().currentSessionId === sessionId) {
      await this.openSession(sessionId)
    }
  }

  async send(
    text: string,
    quotes: MessageQuote[] = [],
    files: MessageFileRef[] = [],
  ): Promise<void> {
    const snapshot = this.getSnapshot()
    const trimmed = text.trim()
    /*
     * 只引用 / 只附文件、不写正文也允许发（§36 / §37）：与桌面**同一条口径** ——
     * 电脑端会在正文为空时补一句（引用 → 「请针对引用的消息回复」，只有文件 → 「看看这些文件」，
     * 见 `buildUserContent`）。若这里拦下来，用户引用了 / 附了文件却发不出去，
     * 会以为「引用坏了」。
     */
    if (!trimmed && quotes.length === 0 && files.length === 0) return
    try {
      let sessionId = snapshot.currentSessionId
      if (!sessionId) {
        // 无会话 = 「新对话」：**发送这一刻**才由电脑侧创建（用户拍板，§22.3）
        sessionId = await this.createSessionFromDraft()
      }
      // 只回「投递确认」；过程由事件推（§3.3）
      //
      // ⚠️ 此处依赖该会话**已在电脑侧登记订阅**（§24）：否则这条消息与后续的流式 / 运行时
      //    都推不回来，界面表现为「标题更新了，但会话没有任何记录」。两条路径都满足：
      //    新会话走 `createSessionFromDraft()`（内部 `openSession()` 已 await 订阅应答），
      //    已有会话来自 `openSession()` / `resync()`；电脑侧另有「自建会话自动订阅」兜底。
      //
      // ⚠️ `quotes` / `files` 都是可选字段：没有时不带（不在线上传一个空数组，也不让旧电脑端
      //    多看到一个它不认识的字段）
      await getCaller().call('host.session.send', {
        sessionId,
        text: trimmed,
        ...(quotes.length > 0 ? { quotes } : {}),
        ...(files.length > 0 ? { files } : {}),
      })
    } catch (err) {
      this.setState((s) => ({ ...s, error: messageOf(err) }))
    }
  }

  /**
   * 按「新对话」的本地选择在电脑侧创建会话（唯一调用点：`send`）。
   *
   * 工作目录 / 模型都会在电脑侧被独立校验（候选集 / 已启用服务），手机侧不预设能力。
   *
   * ⚠️ 创建之后必须走**与打开会话同一条路**（`openSession`：订阅 + 快照），而不是只塞一个
   * 空数组了事 —— 2026-09-29 真机缺陷（§24）：当时只 `create` + `loadSessions`，于是新会话
   * 既没有订阅（消息 / 流式全被电脑侧的订阅门拦掉），也没有快照，用户看到的就是
   * 「标题更新了，但这个会话没有任何记录」。
   */
  private async createSessionFromDraft(): Promise<string> {
    const draft = this.getSnapshot().draft
    const { sessionId } = await getCaller().call('host.session.create', {
      ...(draft.workspace ? { workspace: draft.workspace } : {}),
      ...(draft.providerConfigId ? { providerConfigId: draft.providerConfigId } : {}),
      ...(draft.modelId ? { modelId: draft.modelId } : {}),
      /*
       * Agent：**必须由能力位拦住**。旧电脑端收到这个字段会当普通未知字段静默丢掉 ——
       * 用户以为建的是「代码评审员」，实际建的是默认 Agent；这种假绿灯比报错难发现得多
       * （与 `message.quote` 同一条教训，见共享包 0.5.0 的说明）。
       */
      ...(draft.agentId && this.can('session.agent') ? { agentId: draft.agentId } : {}),
    })
    // 订阅必须在 `send` 之前落地（`openSession` 会 await 到订阅应答）
    await this.openSession(sessionId)
    await this.loadSessions()
    this.setState((s) => ({ ...s, error: undefined }))
    return sessionId
  }

  /**
   * 停止正在生成的回复（M5）。
   *
   * 交互卡片的收敛由电脑侧负责并推 `interaction.resolved`（`settleBySession`）——
   * 本地**不抢先清**，否则会与事件竞争出「卡片闪没又回来」。
   */
  async cancel(sessionId: string): Promise<void> {
    try {
      await getCaller().call('host.session.cancel', { sessionId })
    } catch (err) {
      this.setState((s) => ({ ...s, error: messageOf(err) }))
    }
  }

  /**
   * 从暂停的 run 快照恢复执行（M5，与「暂存」配对）。
   *
   * 与 `send` / `cancel` 同形：RPC 只回投递确认，后续过程（消息 / 运行时）由事件推。
   */
  async resume(sessionId: string): Promise<void> {
    try {
      await getCaller().call('host.session.resume', { sessionId })
    } catch (err) {
      this.setState((s) => ({ ...s, error: messageOf(err) }))
    }
  }

  /**
   * 加载更早的消息（M5 分页）—— 上拉／滚顶触发。
   *
   * 合并按 id 去重：电脑侧游标带失效保护，且分页本身是幂等的，
   * 重复页不会造成重复气泡（消息 id 是权威标识）。
   */
  async loadOlder(): Promise<void> {
    const snapshot = this.getSnapshot()
    const sessionId = snapshot.currentSessionId
    if (!sessionId || snapshot.loadingOlder) return
    if (!snapshot.hasMoreMessages[sessionId]) return
    const cursor = snapshot.cursor[sessionId]
    this.setState((s) => ({ ...s, loadingOlder: true }))
    try {
      const page = await getCaller().call('host.session.messages', {
        sessionId,
        ...(cursor != null ? { fromRowid: cursor } : {}),
      })
      const local = this.getSnapshot().messages[sessionId] ?? []
      const known = new Set(local.map((m) => m.id))
      // ⚠️ 两道去重缺一不可：`known` 挡「与本地重复」（推送通道先到的那份），
      //    `normalizeWindow` 挡「服务端那一页自带的重复」（见 `dedupeMessages` 的注释）。
      const older = page.messages.filter((m) => !known.has(m.id))
      const merged = this.normalizeWindow(sessionId, [...older, ...local])
      this.setState((s) => ({
        ...s,
        loadingOlder: false,
        messages: { ...s.messages, [sessionId]: merged },
        hasMoreMessages: { ...s.hasMoreMessages, [sessionId]: page.hasMore },
        cursor: { ...s.cursor, [sessionId]: page.cursor ?? null },
      }))
    } catch (err) {
      this.setState((s) => ({ ...s, loadingOlder: false, error: messageOf(err) }))
    }
  }

  // ─────────────────── M4：会话写操作（不依赖电脑端已推送，主动刷新一次列表） ───────────────────

  /** 新建会话并切过去（与桌面「新对话」等价）。 */
  async createSession(title?: string): Promise<void> {
    try {
      const { sessionId } = await getCaller().call('host.session.create', title ? { title } : {})
      await this.loadSessions()
      await this.openSession(sessionId)
    } catch (err) {
      this.setState((s) => ({ ...s, error: messageOf(err) }))
    }
  }

  /** 重命名会话（空标题会被电脑侧拒为 `E_BAD_REQUEST`）。 */
  async renameSession(sessionId: string, title: string): Promise<boolean> {
    try {
      await getCaller().call('host.session.rename', { sessionId, title })
      await this.loadSessions()
      return true
    } catch (err) {
      this.setState((s) => ({ ...s, error: messageOf(err) }))
      return false
    }
  }

  /** 置顶 / 取消置顶（目标是「目标态」而不是「切换」—— 本地列表可能已过期）。 */
  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    try {
      await getCaller().call('host.session.pin', { sessionId, pinned })
      await this.loadSessions()
    } catch (err) {
      this.setState((s) => ({ ...s, error: messageOf(err) }))
    }
  }

  /**
   * 删除会话——**不可逆**，故 RPC 必带 `confirm: true`（电脑侧独立校验，见 §16.3-3）。
   * 调用方（UI）负责先弹确认框。
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      await getCaller().call('host.session.delete', { sessionId, confirm: true })
      this.setState((s) => ({
        ...s,
        currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
      }))
      await this.loadSessions()
    } catch (err) {
      this.setState((s) => ({ ...s, error: messageOf(err) }))
    }
  }

  /**
   * 删除一条消息**及其之后的全部消息**（截断，§36）—— **不可逆**。
   *
   * @returns 是否被电脑侧接受（调用方据此决定要不要收起菜单）
   *
   * 与 `deleteSession` / `compressContext` 同形：RPC 必带 `confirm: true`（**电脑侧独立校验**，
   * 手机端那个确认弹窗不算数）。
   *
   * ⚠️ 本地**不先删**：刷新全部交给 `host.event.session.messages.reset` → `reloadMessages`
   * （重拉窗口天然幂等）。先删一次会与事件竞争出「消息闪没又回来」，而且本地删无法处理
   * 「电脑侧拒绝了」这条路径。
   */
  async deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
    // 旧电脑端没有这个方法：UI 本就不显示入口（能力驱动显隐），这里是纵深防御
    if (!this.can(MESSAGE_DELETE_CAPABILITY)) return false
    try {
      await getCaller().call('host.session.message.delete', {
        sessionId,
        messageId,
        confirm: true,
      })
      return true
    } catch (err) {
      this.setState((s) => ({ ...s, error: messageOf(err) }))
      return false
    }
  }

  // ─────────────────── M4：交互应答（提问 / 授权） ───────────────────

  /** 应答一次交互。返回是否被电脑侧接受。 */
  async answer(
    interactionId: string,
    action: AnswerAction,
    options: { value?: unknown; confirmed?: boolean } = {},
  ): Promise<boolean> {
    try {
      const result = await getCaller().call('host.interaction.answer', {
        interactionId,
        action,
        value: options.value,
        confirmed: options.confirmed,
      })
      if (!result.accepted) {
        // 卡片何时收起（2026-09-27 细化，真机反馈）：
        // - `confirm-required` / `unsupported-by-host` / `invalid-value`：**交互仍然有效**，
        //   只是这次没走完（缺确认 / 动作对不上类型 / 内容为空）→ 保留卡片让用户继续；
        // - `not-found` / `already-settled`：电脑侧已不再挂起 → 收起（否则是点不动的僵尸卡片）。
        const keepCard =
          result.reason === 'confirm-required' ||
          result.reason === 'unsupported-by-host' ||
          result.reason === 'invalid-value'
        if (!keepCard) this.dropInteraction(interactionId)
        this.setState((s) => ({
          ...s,
          notice: (result.reason && ANSWER_NOTICE[result.reason]) || '该请求已失效',
        }))
        return false
      }
      this.dropInteraction(interactionId)
      this.setState((s) => ({ ...s, notice: undefined, error: undefined }))
      return true
    } catch (err) {
      this.setState((s) => ({ ...s, error: messageOf(err) }))
      return false
    }
  }

  private dropInteraction(interactionId: string): void {
    this.interactionArrivedAt.delete(interactionId)
    this.setState((s) => ({
      ...s,
      interactions: s.interactions.filter((i) => i.interactionId !== interactionId),
    }))
  }

  /**
   * 拉取「当前待应答交互」快照（链接就绪 / 重连 / **链路代际更替**后调用）。
   *
   * 为什么不能只靠事件：`host.event.interaction.requested` 是**一次性**的 ——
   * 手机在交互发起之后才连上时事件已错过，界面会表现为「会话卡在 working，却没有任何可点的东西」。
   *
   * 合并规则（避免用快照覆盖掉刚收到的事件）：
   * - 快照里有的 → 保留（并补齐本地缺少的）；
   * - 快照里没有、但**本地是本次拉取开始之后**到的 → 保留（它比快照新）；
   * - 其余本地条目 → 丢弃（服务端已不再挂起，属僵尸卡片）。
   *
   * ⚠️ 「本地是什么时候到的」一律看 `interactionArrivedAt`（**本机**时钟），
   * 不拿电脑侧的 `createdAt` 与本机 `Date.now()` 比大小（原因见那个字段的说明）。
   */
  async refreshInteractions(): Promise<void> {
    const startedAt = Date.now()
    try {
      const { interactions } = await getCaller().call('host.interaction.list', {})
      const alive = new Set(interactions.map((i) => i.interactionId))
      const kept = this.getSnapshot().interactions.filter(
        (i) =>
          alive.has(i.interactionId) ||
          (this.interactionArrivedAt.get(i.interactionId) ?? 0) >= startedAt,
      )
      const known = new Set(kept.map((i) => i.interactionId))
      const added = interactions.filter((i) => !known.has(i.interactionId))
      const now = Date.now()
      // 快照来的条目也记到达时刻（= 此刻）：下次拉取若服务端已不再挂起它，就能按僵尸清掉
      for (const i of added) this.interactionArrivedAt.set(i.interactionId, now)
      // 到达记录只留还在列表里的（否则这张表会随「历史上出现过的交互」一直涨）
      const live = new Set([...kept, ...added].map((i) => i.interactionId))
      for (const id of [...this.interactionArrivedAt.keys()]) {
        if (!live.has(id)) this.interactionArrivedAt.delete(id)
      }
      this.setState((s) => ({ ...s, interactions: [...kept, ...added] }))
    } catch {
      /* 拉取失败不弹错：事件通道若活着，卡片照样会来 */
    }
  }

  /**
   * 多端重同步（M5）：链路就绪 / 重连后调用。
   *
   * 为何必需：重连会拿到一个**全新的 Endpoint** —— 旧链路的订阅（含 `host.session.subscribe`）
   * 随旧链路一起消失，且断线期间的事件**不可能补发**。故按「重新拉快照」而非「续传」处理
   * （与 §3.5 的重同步策略一致）。
   *
   * 只重拉当前会话 + 列表，不重置整个 store —— 用户断线前看到的界面不应全部消失。
   */
  async resync(): Promise<void> {
    const sessionId = this.getSnapshot().currentSessionId
    await this.loadSessions()
    if (sessionId && this.getSnapshot().sessions.some((s) => s.id === sessionId)) {
      await this.openSession(sessionId)
    }
  }

  /**
   * 链路**代际更替后重新授权成功**时的重同步（动作与 `onEndpointReady` 完全一致）。
   *
   * 为何单独一条入口：链路可以在**同一次会话里**被重建 —— 本端只看到 `connecting → open`，
   * `connect()` 不会重跑、`onEndpointReady` 也不会再触发（见 `connection.ts::reverify`）。
   * 而这条链路对面可能已经是**另一侧服务实例**（电脑侧 `dropLink` / 重启用都会换链路），
   * 待应答交互的权威快照必须**重新拉一次**：
   * 不拉的话，手机上那张卡片就永远是点不动的僵尸 —— 点一下只会得到
   * 「该请求已在电脑上处理」，而电脑端其实还在等（真机缺陷，2026-10）。
   */
  async resyncAfterReauth(): Promise<void> {
    /*
     * ⚠️ 两件必须**并发**发起（与 `onEndpointReady` 原来的写法一致，`Promise.all` 也是同时开跑）：
     * 串行（先 await 交互快照、再重拉会话）会把 `openSession` 拖到多一个 RPC 之后 ——
     * 首屏消息、工具卡片、分页都跟着晚到，跨连即渲染的用例会大面积超时。
     */
    await Promise.all([this.refreshInteractions(), this.resync()])
  }

  /**
   * 流式帧合并（§32）—— 整帧替换 + 增量按 `offset` 重基准。
   *
   * 为什么不能简单地「是增量就拼」：客户端手上有多少正文**只有它自己知道**。
   * 三种会让它落后的情形：① 中途才订阅（前面的增量已经发过了）；
   * ② `messages.reset` / 切回会话后本地流式态被清空；③ 断线重连（换链路，基准全丢）。
   * `offset` 让这三种情形都能被发现：
   *   - `offset > 本地长度` → **真缺一段** → 拉全文对齐（而不是拼出一段错位正文）；
   *   - `offset + text.length ≤ 本地长度` → 完全重复 → 丢掉（只推进 seq）；
   *   - 部分重叠 → 只取尾巴（`本地长度 − offset` 之后那些字符）。
   */
  private applyStreamFrame(e: HostEvents['host.event.message.stream']): void {
    if (e.final) {
      this.clearStream(e.sessionId)
      return
    }

    // 整帧：首帧 / 正文被改写 / 老电脑一律发整段 —— 直接替换，不存在拼接风险
    if (e.mode !== 'delta') {
      this.setStream(e.sessionId, e.messageId, e.text, e.seq)
      return
    }

    const prev = this.getSnapshot().streaming[e.sessionId]
    const same = prev?.messageId === e.messageId
    const base = same ? prev.text : ''
    const offset = e.offset

    if (offset == null) {
      // 无偏移的增量（本版电脑侧不会发）：只能按 seq 连续性判断，接不上就拉全文
      if (same && e.seq === prev.seq + 1) this.setStream(e.sessionId, e.messageId, base + e.text, e.seq)
      else void this.resyncStream(e.sessionId, e.messageId)
      return
    }

    const skip = offset - base.length
    if (skip > 0) {
      // 缺了一段：先拉全文对齐，**本帧丢弃**（拉回来的是更靠后的正文，包含它）
      void this.resyncStream(e.sessionId, e.messageId)
      return
    }
    const tail = skip < 0 ? e.text.slice(-skip) : e.text
    if (!tail) {
      // 完全重复（重连后服务端仍以旧基准推了几帧）：只推进 seq，不动正文
      if (same) this.setState((s) => ({ ...s, streaming: { ...s.streaming, [e.sessionId]: { ...prev, seq: e.seq } } }))
      return
    }
    this.setStream(e.sessionId, e.messageId, base + tail, e.seq)
  }

  /** 写入流式正文（拼接 / 替换 / 对齐三条路径的唯一落点）。 */
  private setStream(sessionId: string, messageId: string, text: string, seq: number): void {
    this.setState((s) => ({
      ...s,
      streaming: { ...s.streaming, [sessionId]: { messageId, text, seq } },
    }))
  }

  /** 清空流式态（`final` 收口）。定稿正文由随后的 `message.added` 落地。 */
  private clearStream(sessionId: string): void {
    this.setState((s) => {
      if (!s.streaming[sessionId]) return s
      const streaming = { ...s.streaming }
      delete streaming[sessionId]
      return { ...s, streaming }
    })
  }

  /**
   * 增量接不上时**拉全文对齐** —— 协议里的 `host.session.message.get` 就是为它准备的（§3.6/§32）。
   *
   * 为何不「等下一个整帧」：下一个整帧要等到**定稿**（长回复可能几十秒），
   * 而这段等待里用户看到的是一段不会再变长的半截正文 —— 比多一次 RPC 糟得多。
   */
  private async resyncStream(sessionId: string, messageId: string): Promise<void> {
    const key = `${sessionId}\u0001${messageId}`
    if (this.resyncingStreams.has(key)) return
    this.resyncingStreams.add(key)
    try {
      const { message } = await getCaller().call('host.session.message.get', { sessionId, messageId })
      const cur = this.getSnapshot().streaming[sessionId]
      // 只在「还盯着同一条消息」且「拉回来的确实更长」时采用：
      // 期间可能已定稿（streaming 清空）或又收到更新的整帧 —— 都不能被这次应答回退掉
      if (cur?.messageId !== messageId) return
      if (message.text.length <= cur.text.length) return
      this.setStream(sessionId, messageId, message.text, cur.seq)
    } catch {
      /* 拉不到（旧电脑没这个方法 / 链路刚好断了）：退化为「等下一个整帧」，不弹错 */
    } finally {
      this.resyncingStreams.delete(key)
    }
  }

  applyEvent(topic: string, payload: unknown): void {
    switch (topic) {
      case 'host.event.session.context.changed': {
        const e = payload as HostEvents['host.event.session.context.changed']
        // 计数器：让「已发出、但比本事件更旧的快照响应」在回来时自行作废（见 `loadContext`）
        this.contextEventSeq[e.sessionId] = (this.contextEventSeq[e.sessionId] ?? 0) + 1
        this.setState((s) => ({ ...s, context: { ...s.context, [e.sessionId]: e.context } }))
        break
      }
      case 'host.event.session.messages.reset': {
        const e = payload as HostEvents['host.event.session.messages.reset']
        // 整体替换（压缩）/ 删除：本地窗口作废 → 重拉（fire-and-forget，UI 自行显示加载态）
        void this.reloadMessages(e.sessionId)
        break
      }
      case 'host.event.session.list.changed': {
        const e = payload as HostEvents['host.event.session.list.changed']
        this.setState((s) => ({ ...s, sessions: e.sessions }))
        break
      }
      case 'host.event.message.added': {
        const e = payload as HostEvents['host.event.message.added']
        this.setState((s) => {
          const list = s.messages[e.sessionId] ?? []
          if (list.some((m) => m.id === e.message.id)) return s
          const streaming = { ...s.streaming }
          if (streaming[e.sessionId]?.messageId === e.message.id) streaming[e.sessionId] = undefined
          /*
           * ⚠️ 插到**时间序正确的位置**，不是无脑追加（§37）：电脑侧连「向前回补的更早
           * 历史」也走这个事件（它自己的窗口前插了那一页 → 按 id 做 diff 时它们看着就是
           * 「新出现的消息」）。一律追加的话，用户点「加载更早的消息」后，历史会出现在
           * **最下面**（真机反馈）。判据与完整说明见 `lib/messages.ts::insertionIndexFor`。
           */
          const at = insertionIndexFor(list, e.message)
          const next = [...list.slice(0, at), e.message, ...list.slice(at)]
          return { ...s, messages: { ...s.messages, [e.sessionId]: next }, streaming }
        })
        break
      }
      case 'host.event.message.updated': {
        const e = payload as HostEvents['host.event.message.updated']
        this.setState((s) => {
          const list = s.messages[e.sessionId] ?? []
          const next = list.map((m) => (m.id === e.message.id ? e.message : m))
          return { ...s, messages: { ...s.messages, [e.sessionId]: next } }
        })
        break
      }
      case 'host.event.message.stream': {
        this.applyStreamFrame(payload as HostEvents['host.event.message.stream'])
        break
      }
      case 'host.event.session.runtime.changed': {
        const e = payload as HostEvents['host.event.session.runtime.changed']
        this.setState((s) => {
          const error = e.runtime.error || undefined
          const prev = s.sessionError[e.sessionId]
          return {
            ...s,
            working: { ...s.working, [e.sessionId]: e.runtime.working },
            paused: { ...s.paused, [e.sessionId]: e.runtime.paused === true },
            compacting: { ...s.compacting, [e.sessionId]: e.runtime.compacting === true },
            toolProgress: { ...s.toolProgress, [e.sessionId]: e.runtime.toolProgress ?? undefined },
            /*
             * 执行中的工具（§27 姊妹）：字段缺席 = 电脑侧此刻没有在跑的工具 → 本端跟着清
             * （同样权威在电脑侧：工具跑完 / run 结束都由那边不再下发这个字段来表达）。
             */
            runningTools: { ...s.runningTools, [e.sessionId]: e.runtime.runningTools ?? undefined },
            /*
             * 电脑侧的错误（2026-10 真机反馈：过去这里只取了 working / paused / compacting /
             * toolProgress，`runtime.error` 被静默丢掉 —— 会话报错时手机端一个字都看不到）。
             * 字段缺失 = 电脑侧已经没有这条错误 → 本地跟着清（权威在电脑侧）。
             */
            sessionError: { ...s.sessionError, [e.sessionId]: error },
            /*
             * 「无 → 有」= **新的一次错误**（电脑侧在重新发送时会先把上一条清掉）→
             * 撤掉本地的「已读」标记，让**同内容**的错误也能重新弹出来。
             * 只有值没变时才保留标记 —— 否则每次重开会话，那一帧运行时快照都会把用户
             * 刚关掉的提示又弹回来（同一件事反复提醒 = 提醒失效）。
             */
            dismissedError:
              prev === undefined && error !== undefined
                ? { ...s.dismissedError, [e.sessionId]: undefined }
                : s.dismissedError,
          }
        })
        break
      }
      case 'host.event.interaction.requested': {
        const e = payload as HostEvents['host.event.interaction.requested']
        // 记**本机到达时刻**（合并规则不看电脑侧时钟，见 `interactionArrivedAt`）
        this.interactionArrivedAt.set(e.interaction.interactionId, Date.now())
        this.setState((s) => ({
          ...s,
          interactions: s.interactions.some((i) => i.interactionId === e.interaction.interactionId)
            ? s.interactions.map((i) => (i.interactionId === e.interaction.interactionId ? e.interaction : i))
            : [...s.interactions, e.interaction],
        }))
        break
      }
      case 'host.event.interaction.resolved': {
        const e = payload as HostEvents['host.event.interaction.resolved']
        // 可能是电脑上先处理了（`by:'host'`）—— 一样要收起卡片，否则用户会点一个已死的按钮
        this.interactionArrivedAt.delete(e.interactionId)
        this.setState((s) => ({
          ...s,
          interactions: s.interactions.filter((i) => i.interactionId !== e.interactionId),
        }))
        break
      }
      default:
        break
    }
  }
}

const HOST_EVENT_TOPICS = [
  'host.event.session.list.changed',
  'host.event.message.added',
  'host.event.message.updated',
  'host.event.message.stream',
  'host.event.session.runtime.changed',
  'host.event.session.context.changed',
  'host.event.session.messages.reset',
  'host.event.interaction.requested',
  'host.event.interaction.resolved',
] as const

export const chatStore = new ChatStore()

// 连接就绪 → 挂上 host 事件订阅
onEndpointReady((endpoint: Endpoint) => {
  for (const topic of HOST_EVENT_TOPICS) {
    endpoint.subscribe(topic, (payload) => chatStore.applyEvent(topic, payload))
  }
  /*
   * 补齐「在本次连接之前就已挂起」的交互（事件已错过，快照拉回来）：
   *  - 新链路（首次连接 / 自动重连）走到这里；
   *  - **链路代际更替**（本端只看到 `connecting → open`，走不到这里）由
   *    `connection.ts::reverify` 调 `resyncAfterReauth()` 补上 —— 两条路径必须做同一套动作。
   */
  void chatStore.resyncAfterReauth()
})

function messageOf(err: unknown): string {
  if (err instanceof BridgeError) return err.message
  return err instanceof Error ? err.message : String(err)
}

/** 「新对话」的默认选择：最近一个会话的 Agent / 模型 / 工作目录（拿不到就留空，由电脑侧默认值决定）。 */
function seedDraft(sessions: SessionSummaryDTO[]): DraftSelection {
  const latest = sessions[0]
  return {
    ...(latest?.agentId ? { agentId: latest.agentId } : {}),
    ...(latest?.providerConfigId ? { providerConfigId: latest.providerConfigId } : {}),
    ...(latest?.modelId ? { modelId: latest.modelId } : {}),
    ...(latest?.workspace ? { workspace: latest.workspace } : {}),
  }
}
