/**
 * useAppShell — the admin UI as an app inside the viewer shell (D1096).
 *
 * `chromeless` turns true only after the shell's `hello`; a page that is framed
 * without one, or opened standalone, keeps its own sidebar and header. The hook
 * announces `ready` once, routes a `navigate` message, and reports the current
 * path so the drawer marks the active entry.
 */
import { useThemeMode } from '@camstack/ui-library'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  acceptShellMessage,
  shellEndpointOf,
  shellPathOf,
  shellSenderOf,
} from '../lib/app-shell-bridge'

/** A search the shell asked for; `id` changes on every request so the same text can be asked twice. */
export interface ShellSearchRequest {
  readonly id: number
  readonly query: string
}

export interface AppShellState {
  readonly chromeless: boolean
  readonly search: ShellSearchRequest | null
}

export function useAppShell(): AppShellState {
  const navigate = useNavigate()
  const location = useLocation()
  const path = shellPathOf(location)
  const latestPath = useRef(path)
  latestPath.current = path
  const [chromeless, setChromeless] = useState(false)
  const [search, setSearch] = useState<ShellSearchRequest | null>(null)
  const theme = useThemeMode()
  const setMode = theme?.setMode
  const searchCount = useRef(0)
  const send = useMemo(() => shellSenderOf(), [])

  useEffect(() => {
    const endpoint = shellEndpointOf()
    const listener = (event: MessageEvent): void => {
      const message = acceptShellMessage(event, endpoint)
      if (message === null) return
      if (message.type === 'hello') setChromeless(true)
      else if (message.type === 'navigate') navigate(message.path)
      else if (message.type === 'search') {
        searchCount.current += 1
        setSearch({ id: searchCount.current, query: message.query })
      } else if (message.type === 'theme') setMode?.(message.mode)
    }
    window.addEventListener('message', listener)
    // `ready` asks the shell for its hello; the listener is attached first so the answer is not missed.
    send?.({ camstack: 'app-bridge', v: 1, type: 'ready', path: latestPath.current })
    return () => window.removeEventListener('message', listener)
  }, [navigate, send, setMode])

  useEffect(() => {
    send?.({ camstack: 'app-bridge', v: 1, type: 'path', path, title: document.title })
  }, [send, path])

  return { chromeless, search }
}
