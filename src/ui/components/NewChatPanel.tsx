/**
 * NewChatPanel —— 「新对话」面板（§22）。
 *
 * ⚠️ **用户拍板的核心约束**：点「＋」进入新对话时**不在电脑上创建任何会话** ——
 * 这里选的 Agent / 模型 / 工作目录只活在手机内存里（`chatStore.draft`），
 * 直到用户**发出第一条消息**才由电脑侧真正创建（与桌面 `doSend` 同构）。
 * 好处：手机端不会留下一串「点开又反悔」的空会话。
 *
 * 工作目录**只能从候选集里选**（`host.workspace.list`），候选集来自电脑侧既有数据 ——
 * 因此手机端不可能凭空造出一个新目录（越权防线还在电脑侧再校验一次）。
 * Agent（`host.agent.list`）同理。
 *
 * ⚠️ 面板里显示的必须是**实际会生效的值**：显式选过的 > 所选 Agent 的默认值 > 电脑侧默认
 * （与电脑侧 `createSession` 的取值顺序一致）。选 Agent 会清掉模型与工作目录
 * （`store.setDraftAgent`），于是那两行自动回落到新 Agent 的默认值 —— 这正是桌面同语义。
 */
import { useEffect, useState } from 'react'
import { useStore } from '../../lib/store'
import { chatStore } from '../../store/chat'
import { connectionStore } from '../../store/connection'
import { ModelPicker, WorkspacePicker, AgentPicker } from './ModelPicker'
import './NewChatPanel.css'

export default function NewChatPanel() {
  const chat = useStore(chatStore)
  const conn = useStore(connectionStore)
  const [picking, setPicking] = useState<'agent' | 'model' | 'workspace' | null>(null)

  // 候选集按需拉取（三个列表都是电脑侧的白名单投影）
  useEffect(() => {
    void chatStore.loadModels()
    void chatStore.loadWorkspaces()
    void chatStore.loadAgents()
  }, [])

  const can = (cap: string) => conn.capabilities.includes(cap)
  /** 所选 Agent（草稿里没选 = 电脑侧默认 Agent）。 */
  const agent = chat.draft.agentId
    ? chat.agents.find((a) => a.id === chat.draft.agentId)
    : undefined
  // 实际会生效的模型 / 目录（见文件头「显示实际会生效的值」）
  const providerConfigId = chat.draft.providerConfigId ?? agent?.defaultModel?.providerConfigId
  const modelId = chat.draft.modelId ?? agent?.defaultModel?.modelId
  const currentProvider = chat.models.find((p) => p.id === providerConfigId)
  const modelLabel = modelId
    ? `${modelId}${currentProvider ? `　${currentProvider.name}` : ''}`
    : '（默认模型）'
  const workspace = chat.draft.workspace ?? agent?.defaultWorkspace

  if (!can('session.create')) {
    return (
      <div className="newchat__wrap">
        <p className="newchat__note">电脑端未授权手机新建会话，请从右上角会话列表里挑一个会话。</p>
      </div>
    )
  }

  return (
    <div className="newchat__wrap">
      <h2 className="newchat__title">新对话</h2>
      <p className="newchat__note">
        选好 Agent、模型与工作目录后直接发消息 —— <strong>第一条消息发出时</strong>才会在电脑上创建会话。
      </p>

      {/* Agent 放最上面：它决定另外两项的默认值（换 Agent 会重置它们） */}
      {can('session.agent') && (
        <section className="newchat__block">
          <h3 className="newchat__block-title">Agent</h3>
          <button
            type="button"
            className="newchat__row"
            onClick={() => setPicking((v) => (v === 'agent' ? null : 'agent'))}
          >
            <span className="newchat__row-label">
              {agent ? agent.name : '默认 Agent（电脑侧决定）'}
            </span>
            <span className="newchat__row-hint">{picking === 'agent' ? '收起' : '选择'}</span>
          </button>
          {picking === 'agent' && (
            <AgentPicker
              agents={chat.agents}
              loading={chat.loadingAgents}
              current={chat.draft.agentId}
              onPick={(agentId) => {
                chatStore.setDraftAgent(agentId)
                setPicking(null)
              }}
            />
          )}
          <p className="newchat__note newchat__note--small">
            Agent 决定这条会话的提示词与可用工具；换 Agent 会把下面两项重置为它的默认值。
          </p>
        </section>
      )}

      <section className="newchat__block">
        <h3 className="newchat__block-title">模型</h3>
        <button
          type="button"
          className="newchat__row"
          disabled={!can('session.model')}
          onClick={() => setPicking((v) => (v === 'model' ? null : 'model'))}
        >
          <span className="newchat__row-label">{modelLabel}</span>
          <span className="newchat__row-hint">
            {picking === 'model' ? '收起' : can('session.model') ? '选择' : '不可选'}
          </span>
        </button>
        {picking === 'model' && (
          <ModelPicker
            providers={chat.models}
            loading={chat.loadingModels}
            current={{ providerConfigId, modelId }}
            onPick={(pid, mid) => {
              void chatStore.setModel(pid, mid)
              setPicking(null)
            }}
          />
        )}
      </section>

      {can('session.workspace') && (
        <section className="newchat__block">
          <h3 className="newchat__block-title">工作目录</h3>
          <button
            type="button"
            className="newchat__row"
            onClick={() => setPicking((v) => (v === 'workspace' ? null : 'workspace'))}
          >
            <span className="newchat__row-label newchat__row-label--mono">
              {workspace || '（电脑侧默认目录）'}
            </span>
            <span className="newchat__row-hint">{picking === 'workspace' ? '收起' : '选择'}</span>
          </button>
          {picking === 'workspace' && (
            <WorkspacePicker
              workspaces={chat.workspaces}
              loading={chat.loadingWorkspaces}
              current={workspace}
              onPick={(path) => {
                chatStore.setDraftWorkspace(path)
                setPicking(null)
              }}
            />
          )}
          <p className="newchat__note newchat__note--small">
            只列出电脑上已有过的目录 —— 手机端不能创建新目录。
          </p>
        </section>
      )}
    </div>
  )
}
