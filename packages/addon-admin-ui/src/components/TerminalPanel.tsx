/**
 * TerminalPanel — a real vt terminal (xterm.js) bound to a live
 * `terminal-session`.
 *
 * This is deliberately NOT the hand-rolled line buffer in `ReplTerminal`: a
 * monitoring TUI (`btm`) needs a full ANSI/vt parser, alt-screen, colour and
 * reflow. The panel:
 *   - mounts an `@xterm/xterm` Terminal + `FitAddon` into a ref'd div,
 *   - pulls ordered output through the node-routable capability plane,
 *   - forwards keystrokes through the same capability plane,
 *   - calls the `resize` capability (debounced) whenever the fit changes,
 *   - tears everything down (abort stream, dispose terminal) on unmount.
 *
 * Lifecycle (open/close/list) is the capability's job and lives in the page;
 * the panel owns only the byte plane for one already-open session.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  useTerminalSessionPullOutput,
  useTerminalSessionResize,
  useTerminalSessionWriteInput,
} from '@camstack/ui-library'

/** Reported when the pty terminates, so the page can flip the session out. */
export interface TerminalExitInfo {
  readonly exitCode: number
  readonly signal?: number
}

interface TerminalPanelProps {
  readonly sessionId: string
  readonly nodeId: string
  readonly onExit?: (info: TerminalExitInfo) => void
  readonly className?: string
}

const RESIZE_DEBOUNCE_MS = 200
const OUTPUT_LONG_POLL_MS = 1_000
const OUTPUT_ERROR_RETRY_MS = 500

/**
 * A refined dark terminal theme. Terminals read best on a dark ground
 * regardless of the app's light/dark mode, so this is fixed rather than
 * following the theme — the panel is framed by a themed card instead.
 */
const XTERM_THEME = {
  background: '#0b0d10',
  foreground: '#d7dce2',
  cursor: '#7dd3fc',
  cursorAccent: '#0b0d10',
  selectionBackground: '#334155',
  black: '#0b0d10',
  brightBlack: '#475569',
  red: '#f87171',
  brightRed: '#fca5a5',
  green: '#4ade80',
  brightGreen: '#86efac',
  yellow: '#fbbf24',
  brightYellow: '#fcd34d',
  blue: '#60a5fa',
  brightBlue: '#93c5fd',
  magenta: '#c084fc',
  brightMagenta: '#d8b4fe',
  cyan: '#22d3ee',
  brightCyan: '#67e8f9',
  white: '#cbd5e1',
  brightWhite: '#f1f5f9',
} as const

export function TerminalPanel({ sessionId, nodeId, onExit, className }: TerminalPanelProps) {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exited, setExited] = useState<TerminalExitInfo | null>(null)

  const resize = useTerminalSessionResize()
  const pullOutput = useTerminalSessionPullOutput()
  const writeInput = useTerminalSessionWriteInput()
  // Keep the latest mutate / onExit in refs so the mount effect can stay keyed
  // on `sessionId` alone and never re-run just because a callback identity
  // changed (which would rebuild the whole terminal).
  const resizeMutate = useRef(resize.mutate)
  resizeMutate.current = resize.mutate
  const pullOutputMutate = useRef(pullOutput.mutateAsync)
  pullOutputMutate.current = pullOutput.mutateAsync
  const writeInputMutate = useRef(writeInput.mutateAsync)
  writeInputMutate.current = writeInput.mutateAsync
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    setError(null)
    setExited(null)

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: XTERM_THEME,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(host)

    let disposed = false
    let lastCols = 0
    let lastRows = 0
    let debounce: ReturnType<typeof setTimeout> | null = null

    const applyFit = () => {
      if (disposed) return
      try {
        fitAddon.fit()
      } catch {
        // The host can be momentarily zero-sized (tab switch, layout thrash);
        // the ResizeObserver will call us again once it has real dimensions.
        return
      }
      const { cols, rows } = term
      if (cols === lastCols && rows === lastRows) return
      lastCols = cols
      lastRows = rows
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        resizeMutate.current({ nodeId, sessionId, cols, rows })
      }, RESIZE_DEBOUNCE_MS)
    }

    // Fit once the browser has laid the host out, then track future changes.
    const raf = requestAnimationFrame(applyFit)
    const observer = new ResizeObserver(applyFit)
    observer.observe(host)

    const inputSub = term.onData((data) => {
      void writeInputMutate.current({ nodeId, sessionId, data }).catch(() => {
        if (!disposed) setError('Failed to send input to the session.')
      })
    })

    let cursor = 0
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    const pollOutput = async (): Promise<void> => {
      if (disposed) return
      try {
        const batch = await pullOutputMutate.current({
          nodeId,
          sessionId,
          afterSeq: cursor,
          waitMs: OUTPUT_LONG_POLL_MS,
        })
        if (disposed) return
        setError(null)
        if (batch.reset) {
          term.reset()
          if (batch.snapshot) term.write(batch.snapshot)
        }
        for (const event of batch.events) {
          if (event.kind === 'data') {
            term.write(event.data)
            continue
          }
          const info: TerminalExitInfo = { exitCode: event.exitCode, signal: event.signal }
          setExited(info)
          term.write(
            `\r\n\x1b[38;5;244m── session exited (code ${String(event.exitCode)}) ──\x1b[0m\r\n`,
          )
          onExitRef.current?.(info)
          return
        }
        cursor = batch.cursor
        pollTimer = setTimeout(pollOutput, 0)
      } catch {
        if (disposed) return
        setError('Lost connection to the terminal session. Retrying…')
        pollTimer = setTimeout(pollOutput, OUTPUT_ERROR_RETRY_MS)
      }
    }
    void pollOutput()

    term.focus()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      if (debounce) clearTimeout(debounce)
      if (pollTimer) clearTimeout(pollTimer)
      observer.disconnect()
      inputSub.dispose()
      term.dispose()
    }
  }, [nodeId, sessionId])

  return (
    <div
      className={`overflow-hidden rounded-lg border border-border bg-[#0b0d10] ${className ?? ''}`}
    >
      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
          {error}
        </div>
      )}
      {exited && !error && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
          {typeof exited.signal === 'number'
            ? t('terminal.panel.exitedSignal', {
                code: exited.exitCode,
                signal: String(exited.signal),
              })
            : t('terminal.panel.exited', { code: exited.exitCode })}
        </div>
      )}
      {/* xterm sizes to this host; give it a stable min-height so the FitAddon
          has real dimensions to measure on first paint. */}
      <div ref={hostRef} className="h-[480px] w-full p-2" />
    </div>
  )
}
