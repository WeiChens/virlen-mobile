/**
 * ModelPicker / WorkspacePicker / AgentPicker —— 手机端的「候选选择」列表（**单一实现，多处复用**）。
 *
 * 宿主：「新对话」面板（选新会话的 Agent / 模型 / 工作目录）与会话信息面板（切已有会话的模型）。
 * 几处若各写一份渲染，必然出现「一边能选、另一边选不了」这类分叉。
 *
 * ⚠️ 三者都只做**展示 + 回调**：候选集来自电脑侧（`host.agent.list` / `host.model.list` /
 * `host.workspace.list`），合法性由电脑侧独立校验（手机端不预判、也不自造候选）。
 */
import type { AgentOptionDTO, ModelProviderDTO, WorkspaceOptionDTO } from 'virlen-remote'
import { baseNameOf } from '../../lib/session-groups'
import { IconCheck } from './icons'
import './pickers.css'

interface AgentPickerProps {
  agents: AgentOptionDTO[]
  loading: boolean
  current?: string
  onPick: (agentId: string | undefined) => void
}

/**
 * Agent 候选集（新建会话用）。
 *
 * 首项是「不指定」（= 电脑侧默认 Agent）—— 草稿的初始态就是它，
 * 不给一条回去的路，用户切过去就只能靠重进面板了。
 */
export function AgentPicker({ agents, loading, current, onPick }: AgentPickerProps) {
  if (loading && agents.length === 0) return <p className="picker__hint">加载 Agent…</p>
  if (agents.length === 0) return <p className="picker__hint">电脑侧没有可选的 Agent</p>
  return (
    <div className="picker">
      <button
        type="button"
        className={`picker__item${current ? '' : ' is-on'}`}
        onClick={() => onPick(undefined)}
      >
        <span className="picker__item-main">
          <span className="picker__item-name">不指定（电脑侧默认 Agent）</span>
          <span className="picker__item-path">与桌面「直接新建」同构</span>
        </span>
        {!current && <IconCheck />}
      </button>
      {agents.map((agent) => {
        const active = agent.id === current
        // 默认值只用于展示（真正生效的值由电脑侧在 createSession 里组装）
        const meta = [
          agent.defaultModel?.modelId,
          agent.defaultWorkspace ? baseNameOf(agent.defaultWorkspace) : undefined,
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <button
            key={agent.id}
            type="button"
            className={`picker__item${active ? ' is-on' : ''}`}
            onClick={() => onPick(agent.id)}
          >
            <span className="picker__item-main">
              <span className="picker__item-name">{agent.name}</span>
              {meta && <span className="picker__item-path">默认：{meta}</span>}
            </span>
            {active && <IconCheck />}
          </button>
        )
      })}
    </div>
  )
}

interface ModelPickerProps {
  providers: ModelProviderDTO[]
  loading: boolean
  current?: { providerConfigId?: string; modelId?: string }
  onPick: (providerConfigId: string, modelId: string) => void
}

export function ModelPicker({ providers, loading, current, onPick }: ModelPickerProps) {
  if (loading && providers.length === 0) return <p className="picker__hint">加载模型…</p>
  if (providers.length === 0) return <p className="picker__hint">电脑侧没有已启用的模型服务</p>
  return (
    <div className="picker">
      {providers.map((provider) => (
        <div key={provider.id} className="picker__group">
          <div className="picker__group-name">{provider.name}</div>
          {provider.models.map((modelId) => {
            const active = provider.id === current?.providerConfigId && modelId === current?.modelId
            return (
              <button
                key={`${provider.id}-${modelId}`}
                type="button"
                className={`picker__item${active ? ' is-on' : ''}`}
                onClick={() => onPick(provider.id, modelId)}
              >
                <span className="picker__item-name">{modelId}</span>
                {active && <IconCheck />}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

interface WorkspacePickerProps {
  workspaces: WorkspaceOptionDTO[]
  loading: boolean
  current?: string
  onPick: (path: string) => void
}

export function WorkspacePicker({ workspaces, loading, current, onPick }: WorkspacePickerProps) {
  if (loading && workspaces.length === 0) return <p className="picker__hint">加载工作目录…</p>
  if (workspaces.length === 0) {
    return (
      <p className="picker__hint">
        电脑侧还没有可用目录（先在一个目录里建过会话，或设置默认工作目录）
      </p>
    )
  }
  return (
    <div className="picker">
      {workspaces.map((workspace) => {
        const active = workspace.path === current
        return (
          <button
            key={workspace.path}
            type="button"
            className={`picker__item${active ? ' is-on' : ''}`}
            onClick={() => onPick(workspace.path)}
          >
            <span className="picker__item-main">
              <span className="picker__item-name">{workspace.name}</span>
              <span className="picker__item-path">{workspace.path}</span>
            </span>
            <span className="picker__item-count">{workspace.sessionCount} 个会话</span>
            {active && <IconCheck />}
          </button>
        )
      })}
    </div>
  )
}
