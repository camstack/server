/**
 * The hub's human name (D861), from `system.info` - the call the admin UI
 * already makes once signed in. `info` is `null` until the hub has ANSWERED, and
 * stays `null` when it fails: an unanswered query is not an unnamed hub, so
 * nothing here ever invents a name or prompts on a guess.
 */
import { type ServerNameInfo } from '@camstack/types'
import { useSystemInfo } from '@camstack/ui-library'

export interface ServerNameState {
  readonly info: ServerNameInfo | null
  readonly isLoading: boolean
}

const SERVER_NAME_STALE_MS = 60_000

export function useServerName(): ServerNameState {
  const query = useSystemInfo(undefined, { staleTime: SERVER_NAME_STALE_MS })
  return { info: query.data?.serverName ?? null, isLoading: query.isLoading }
}
