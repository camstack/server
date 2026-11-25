/**
 * useAppShell — the admin UI as an app inside the viewer shell (D1096).
 *
 * `chromeless` turns true only after the shell's `hello`; a page that is framed
 * without one, or opened standalone, keeps its own sidebar and header. The hook
 * announces `ready` once, routes a `navigate` message, and reports the current
 * path so the drawer marks the active entry.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  acceptShellMessage,
  shellEndpointOf,
  shellPathOf,
  shellSenderOf,
} from '../lib/app-shell-bridge'

export interface AppShellState {
  readonly chromeless: boolean
}

export function useAppShell(): AppShellState {
  const navigate = useNavigate()
  const location = useLocation()
  const path = shellPathOf(location)
  const latestPath = useRef(path)
  latestPath.current = path
  const [chromeless, setChromeless] = useState(false)
  const send = useMemo(() => shellSenderOf(), [])

  useEffect(() => {
    const endpoint = shellEndpointOf()
    const listener = (event: MessageEvent): void => {
      const message = acceptShellMessage(event, endpoint)
      if (message === null) return
      if (message.type === 'hello') setChromeless(true)
      else if (message.type === 'navigate') navigate(message.path)
    }
    window.addEventListener('message', listener)
    // `ready` asks the shell for its hello; the listener is attached first so the answer is not missed.
    send?.({ camstack: 'app-bridge', v: 1, type: 'ready', path: latestPath.current })
    return () => window.removeEventListener('message', listener)
  }, [navigate, send])

  useEffect(() => {
    send?.({ camstack: 'app-bridge', v: 1, type: 'path', path, title: document.title })
  }, [send, path])

  return { chromeless }
}
