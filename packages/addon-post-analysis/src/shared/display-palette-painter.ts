/**
 * Paints a class with the cluster display palette (D939).
 *
 * The read is cached. A failed or `unknown` read is not stored as the
 * default: the painter keeps the bundled CamStack preset and says so once.
 */
import type { IScopedLogger } from '@camstack/types'
import { bundledCamstack, paintHex, paletteResultSchema, type PaletteReady } from '@camstack/types'

const REFRESH_MS = 30_000

export interface DisplayPalettePainter {
  readonly paint: (kind: string) => string
}

interface PaletteQueryApi {
  readonly displayPalette: {
    readonly getPalette: {
      readonly query: () => Promise<unknown>
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPaletteQueryApi(value: object): value is PaletteQueryApi {
  if (!('displayPalette' in value)) return false
  const cap: unknown = value.displayPalette
  if (!isRecord(cap) || !('getPalette' in cap)) return false
  const method: unknown = cap.getPalette
  if (!isRecord(method) || typeof method.query !== 'function') return false
  return true
}

/** `getPalette` when the cap is mounted. Otherwise a rejection the painter logs. */
export function readDisplayPalette(api: object): Promise<unknown> {
  if (!isPaletteQueryApi(api)) {
    return Promise.reject(new Error('display-palette capability is not mounted'))
  }
  return api.displayPalette.getPalette.query()
}

export function createDisplayPalettePainter(
  read: () => Promise<unknown>,
  logger: IScopedLogger,
): DisplayPalettePainter {
  let ready: PaletteReady = bundledCamstack()
  let announced = false
  let refreshing = false
  let fetchedAt = 0

  const say = (reason: string): void => {
    if (announced) return
    announced = true
    logger.warn('painting the bundled CamStack preset', { meta: { reason } })
  }

  const refresh = (): void => {
    refreshing = true
    void read()
      .then((value) => {
        const parsed = paletteResultSchema.safeParse(value)
        if (!parsed.success) {
          ready = bundledCamstack()
          say('palette read did not match the schema')
          return
        }
        if (parsed.data.status === 'unknown') {
          ready = bundledCamstack()
          say(parsed.data.reason)
          return
        }
        ready = parsed.data
        announced = false
      })
      .catch((err: unknown) => {
        ready = bundledCamstack()
        say(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        fetchedAt = Date.now()
        refreshing = false
      })
  }

  refresh()

  const paint = (kind: string): string => {
    if (Date.now() - fetchedAt >= REFRESH_MS && !refreshing) refresh()
    return paintHex(ready.swatches, ready.fallbacks, kind)
  }

  return { paint }
}
