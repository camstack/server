/**
 * The lifetime of ONE node shell, bound to the section that shows it: the
 * `server-shell` session is opened when the section mounts and closed when it
 * unmounts (another node picked, the section closed, the tab or page left) or
 * the page is hidden. A tab killed outright closes nothing — the provider's
 * idle timeout reaps that shell.
 *
 * Nothing is reattached: a shell left behind by another tab belongs to that
 * tab (or to the idle timeout), so opening a node's section always starts a
 * fresh, audited session.
 */
import { useTerminalSessionClose, useTerminalSessionOpenSession } from '@camstack/ui-library'
import { useEffect, useRef, useState } from 'react'

export const SERVER_SHELL_PROFILE_ID = 'server-shell'

// The panel reflows to its pane the moment it mounts (FitAddon `resize`);
// these are only the grid the pty spawns with.
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32

export interface NodeShellSessionState {
  readonly sessionId: string | null
  readonly error: string | null
}

export function useNodeShellSession(nodeId: string): NodeShellSessionState {
  const openSession = useTerminalSessionOpenSession()
  const closeSession = useTerminalSessionClose()
  const openRef = useRef(openSession.mutateAsync)
  const closeRef = useRef(closeSession.mutateAsync)
  openRef.current = openSession.mutateAsync
  closeRef.current = closeSession.mutateAsync
  const [state, setState] = useState<NodeShellSessionState>({ sessionId: null, error: null })

  useEffect(() => {
    let left = false
    let openedId: string | null = null
    // A close on the way out has nowhere to report a failure: the section is
    // gone. The provider's idle timeout is the backstop for a close that fails.
    const closeOpened = () => {
      if (openedId === null) return
      const sessionId = openedId
      openedId = null
      void closeRef.current({ nodeId, sessionId }).catch(() => undefined)
    }
    // Deferred one tick so a mount that is immediately undone (React's
    // StrictMode double-mount) never spawns a shell.
    const timer = setTimeout(() => {
      openRef
        .current({
          nodeId,
          profileId: SERVER_SHELL_PROFILE_ID,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
        })
        .then((opened) => {
          openedId = opened.sessionId
          if (left) {
            closeOpened()
            return
          }
          setState({ sessionId: opened.sessionId, error: null })
        })
        .catch((error: unknown) => {
          if (left) return
          setState({
            sessionId: null,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }, 0)
    window.addEventListener('pagehide', closeOpened)
    return () => {
      left = true
      clearTimeout(timer)
      window.removeEventListener('pagehide', closeOpened)
      closeOpened()
    }
  }, [nodeId])

  return state
}
