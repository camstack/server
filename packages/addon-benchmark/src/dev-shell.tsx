/**
 * Dev shell — standalone runner for addon page development.
 * Uses DevShell from @dominevo/ui for login, theme, and tRPC client setup.
 */
import './index.css'
import ReactDOM from 'react-dom/client'
import { DevShell } from '@dominevo/ui-library'
import BenchmarkPage from './page'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <DevShell serverUrl="https://localhost:4443" title="Benchmark">
    {({ trpc, theme }) => (
      <BenchmarkPage
        trpc={trpc}
        theme={{ isDark: theme.resolvedMode === 'dark' }}
        navigate={(p: string) => console.log('nav:', p)}
      />
    )}
  </DevShell>,
)
