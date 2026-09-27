/**
 * ModelPicker / WorkspacePicker —— 手机端的两组「候选选择」列表（**单一实现，两处复用**）。
 *
 * 宿主：会话信息面板（切已有会话的模型）与「新对话」面板（选新会话的模型 / 工作目录）。
 * 两处若各写一份渲染，必然出现「一边能选、另一边选不了」这类分叉。
 *
 * ⚠️ 两者都只做**展示 + 回调**：候选集来自电脑侧（`host.model.list` / `host.workspace.list`），
 * 合法性由电脑侧独立校验（手机端不预判、也不自造候选）。
 */
import type { ModelProviderDTO, WorkspaceOptionDTO } from 'virlen-remote'
import { IconCheck } from './icons'
import './pickers.css'

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
