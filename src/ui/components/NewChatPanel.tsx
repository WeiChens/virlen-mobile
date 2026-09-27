/**
 * NewChatPanel —— 「新对话」面板（§22）。
 *
 * ⚠️ **用户拍板的核心约束**：点「＋」进入新对话时**不在电脑上创建任何会话** ——
 * 这里选的模型 / 工作目录只活在手机内存里（`chatStore.draft`），
 * 直到用户**发出第一条消息**才由电脑侧真正创建（与桌面 `doSend` 同构）。
 * 好处：手机端不会留下一串「点开又反悔」的空会话。
 *
 * 工作目录**只能从候选集里选**（`host.workspace.list`），候选集来自电脑侧既有数据 ——
 * 因此手机端不可能凭空造出一个新目录（越权防线还在电脑侧再校验一次）。
 * 已有会话不可改工作目录（参见会话信息面板的说明）。
 */
import { useEffect, useState } from 'react'
import { useStore } from '../../lib/store'
import { chatStore } from '../../store/chat'
import { connectionStore } from '../../store/connection'
import { ModelPicker, WorkspacePicker } from './ModelPicker'
import './NewChatPanel.css'

export default function NewChatPanel() {
  const chat = useStore(chatStore)
  const conn = useStore(connectionStore)
  const [picking, setPicking] = useState<'model' | 'workspace' | null>(null)

  // 候选集按需拉取（两个列表都是电脑侧的白名单投影）
  useEffect(() => {
    void chatStore.loadModels()
    void chatStore.loadWorkspaces()
  }, [])

  const can = (cap: string) => conn.capabilities.includes(cap)
  const currentProvider = chat.models.find((p) => p.id === chat.draft.providerConfigId)
  const modelLabel = chat.draft.modelId
    ? `${chat.draft.modelId}${currentProvider ? `　${currentProvider.name}` : ''}`
    : '（默认模型）'

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
        选好模型与工作目录后直接发消息 —— <strong>第一条消息发出时</strong>才会在电脑上创建会话。
      </p>

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
            current={chat.draft}
            onPick={(providerConfigId, modelId) => {
              void chatStore.setModel(providerConfigId, modelId)
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
              {chat.draft.workspace || '（电脑侧默认目录）'}
            </span>
            <span className="newchat__row-hint">{picking === 'workspace' ? '收起' : '选择'}</span>
          </button>
          {picking === 'workspace' && (
            <WorkspacePicker
              workspaces={chat.workspaces}
              loading={chat.loadingWorkspaces}
              current={chat.draft.workspace}
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
