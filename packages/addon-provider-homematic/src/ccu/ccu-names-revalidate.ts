import type { CcuActionDeps, CcuFacade } from './ccu-facade.js'
import { errorText } from './ccu-facade.js'

/**
 * How long the CCU names a page shows may be before a read revalidates them.
 * The library reads names once at connect and again when a device is paired; a
 * rename done on the CCU afterwards, or a name given to an already paired
 * device, reaches the page only through this.
 */
export const CCU_NAMES_STALE_MS = 60_000

interface NamesState {
  /** When the last revalidation was started; names are fresh until then + the window. */
  startedAt: number
  inFlight: boolean
}

/** Per live facade: a reconnect builds a new facade, whose names were just read. */
const states = new WeakMap<CcuFacade, NamesState>()

/**
 * Serve-and-revalidate for the CCU names a page shows: the caller answers from
 * the names the facade holds now, and when they are older than the window one
 * background re-read starts, so the next read shows the new names. No timer:
 * only a read starts it, and a read never waits for it.
 */
export function revalidateCcuNames(
  deps: CcuActionDeps,
  integrationId: string,
  facade: CcuFacade,
  now: number = Date.now(),
): void {
  const state = states.get(facade)
  if (state !== undefined && (state.inFlight || now - state.startedAt < CCU_NAMES_STALE_MS)) return
  const next: NamesState = { startedAt: now, inFlight: true }
  states.set(facade, next)
  void facade
    .refreshNames()
    .catch((err: unknown) => {
      deps.logger.warn('Homematic: CCU names could not be re-read, keeping the ones shown', {
        meta: { integrationId, error: errorText(err) },
      })
    })
    .finally(() => {
      next.inFlight = false
    })
}
