import Login from './ui/pages/Login'
import Chat from './ui/pages/Chat'
import ErrorBoundary from './components/ErrorBoundary'
import { useStore } from './lib/store'
import { connectionStore } from './store/connection'

export default function App() {
  const conn = useStore(connectionStore)
  return (
    <ErrorBoundary>
      <div className="app">{conn.status === 'online' ? <Chat /> : <Login />}</div>
    </ErrorBoundary>
  )
}
