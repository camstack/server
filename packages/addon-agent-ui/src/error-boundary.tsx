/**
 * Error surface for the agent UI — guarantees a renderer failure is NEVER a
 * silent blank page:
 *
 * - `AgentUiErrorBoundary` catches React render/lifecycle errors and paints a
 *   visible panel (inline styles only — the stylesheet may be the thing that
 *   failed to load).
 * - `installGlobalErrorSurface()` catches errors OUTSIDE React (module-eval
 *   crashes, unhandled promise rejections before mount) and paints the same
 *   panel into `#root` when nothing rendered.
 *
 * Everything is also logged via `console.error`, which the Electron wrapper
 * forwards to the agent log (`console-message` forwarding in main.ts).
 */

import type { CSSProperties, ErrorInfo, ReactNode } from 'react'
import { Component } from 'react'
import { translate } from './i18n'

const PANEL_STYLE: CSSProperties = {
  minHeight: '100vh',
  margin: 0,
  padding: '48px 32px',
  background: '#0c0a09',
  color: '#fafaf9',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
}

const PRE_STYLE: CSSProperties = {
  marginTop: 16,
  padding: 12,
  background: '#1c1917',
  border: '1px solid #292524',
  borderRadius: 8,
  color: '#f87171',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

interface AgentUiErrorBoundaryProps {
  readonly children: ReactNode
}

interface AgentUiErrorBoundaryState {
  readonly error: unknown | null
}

export class AgentUiErrorBoundary extends Component<
  AgentUiErrorBoundaryProps,
  AgentUiErrorBoundaryState
> {
  override state: AgentUiErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): AgentUiErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      `[agent-ui] React render error: ${describeError(error)}${info.componentStack ?? ''}`,
    )
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div style={PANEL_STYLE}>
        <h1 style={{ fontSize: 18, margin: 0 }}>{translate('crash.title')}</h1>
        <p style={{ color: '#a8a29e', fontSize: 13 }}>{translate('crash.body')}</p>
        <pre style={PRE_STYLE}>{describeError(this.state.error)}</pre>
      </div>
    )
  }
}

/** Paint a fatal-error panel straight into #root — only when nothing rendered. */
function paintFatalIfBlank(message: string): void {
  const root = document.getElementById('root')
  if (!root || root.childElementCount > 0) return
  root.innerHTML = ''
  const panel = document.createElement('div')
  panel.setAttribute(
    'style',
    'min-height:100vh;margin:0;padding:48px 32px;background:#0c0a09;color:#fafaf9;' +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
  )
  const title = document.createElement('h1')
  title.setAttribute('style', 'font-size:18px;margin:0 0 8px')
  title.textContent = translate('crash.startFailed')
  const pre = document.createElement('pre')
  pre.setAttribute(
    'style',
    'margin-top:16px;padding:12px;background:#1c1917;border:1px solid #292524;' +
      'border-radius:8px;color:#f87171;font-size:12px;white-space:pre-wrap;word-break:break-word',
  )
  pre.textContent = message
  panel.appendChild(title)
  panel.appendChild(pre)
  root.appendChild(panel)
}

/**
 * Global (non-React) error surface: window `error` + `unhandledrejection`.
 * Errors that strike before/instead of the React mount become a visible
 * panel instead of a blank page; errors after a successful mount are only
 * logged (the boundary owns in-tree failures).
 */
export function installGlobalErrorSurface(): void {
  window.addEventListener('error', (evt) => {
    console.error(`[agent-ui] uncaught error: ${describeError(evt.error ?? evt.message)}`)
    paintFatalIfBlank(describeError(evt.error ?? evt.message))
  })
  window.addEventListener('unhandledrejection', (evt) => {
    console.error(`[agent-ui] unhandled rejection: ${describeError(evt.reason)}`)
    paintFatalIfBlank(describeError(evt.reason))
  })
}
