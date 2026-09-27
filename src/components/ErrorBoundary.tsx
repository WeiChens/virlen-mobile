import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 全局错误边界。
 *
 * 为什么手机端必须有：手机上看不到 console / 调试面板。一旦渲染期（含 `useEffect` 内
 * **同步**抛出）出现未捕获异常，React 会**卸载整棵树** → 屏幕只剩深色 body，表现为
 * 「全黑、什么都没有」——极难排查。这里把它拦下来，**把错误原文直接显示在屏幕上**。
 *
 * 注意：只捕获**渲染 / 生命周期同步**异常；异步 Promise 拒绝仍需各自 `.catch`。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留到 console（连电脑调试时可见）
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          padding: '24px',
          background: '#0f0f10',
          color: '#ececf1',
          overflow: 'auto',
          font: "14px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        <h2 style={{ color: '#ff9d9d', marginTop: 0 }}>页面出错了</h2>
        <p style={{ color: '#9a9aa5' }}>请把下面的信息反馈给开发者（手机上看不到调试面板，故直接展示）：</p>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: '#17171b',
            padding: '12px',
            borderRadius: '10px',
            border: '1px solid #2a2a31',
          }}
        >
          {error.name}: {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
        </pre>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          style={{
            marginTop: '12px',
            padding: '8px 16px',
            borderRadius: '10px',
            border: '1px solid #3a3a44',
            background: '#232329',
            color: '#ececf1',
            font: 'inherit',
          }}
        >
          重试
        </button>
      </div>
    )
  }
}
