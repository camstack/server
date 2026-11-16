/**
 * The lifetime of ONE node shell, bound to the section that shows it: the
 * `server-shell` session is opened when the section mounts and closed when it
 * unmounts (another node picked, the section closed, the tab left, or the page
 * restored from the back/forward cache — `NodeShells` resets the section on
 * `pageshow`). A page that is closed or navigated away closes nothing: such a
 * shell keeps running until the idle timeout (only while it prints nothing) or
 * until an admin closes it from the node's running-shells list.
 *
 * A close that fails is reported through `onCloseFailed`, to the page that
 * outlives this section — never swallowed.
 *
 * Nothing is reattached: opening a node's section always starts a fresh,
 * audited session.
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

export type NodeShellCloseFailed = (message: string) => void

export function useNodeShellSession(
  nodeId: string,
  onCloseFailed: NodeShellCloseFailed,
): NodeShellSessionState {
  const openSession = useTerminalSessionOpenSession()
  const closeSession = useTerminalSessionClose()
  const openRef = useRef(openSession.mutateAsync)
  const closeRef = useRef(closeSession.mutateAsync)
  openRef.current = openSession.mutateAsync
  closeRef.current = closeSession.mutateAsync
  const failedRef = useRef(onCloseFailed)
  failedRef.current = onCloseFailed
  const [state, setState] = useState<NodeShellSessionState>({ sessionId: null, error: null })

  useEffect(() => {
    let left = false
    let openedId: string | null = null
    // The section is gone by the time a close on the way out answers, so a
    // failure goes to the page; the shell stays in the node's running list.
    const closeOpened = () => {
      if (openedId === null) return
      const sessionId = openedId
      openedId = null
      closeRef.current({ nodeId, sessionId }).catch((error: unknown) => {
        failedRef.current(error instanceof Error ? error.message : String(error))
      })
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
    return () => {
      left = true
      clearTimeout(timer)
      closeOpened()
    }
  }, [nodeId])

  return state
}
