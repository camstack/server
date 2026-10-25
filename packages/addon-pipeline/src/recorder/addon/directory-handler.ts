/**
 * Serves the segment directory (`CSD1`) off the playback data plane.
 *
 * `GET <playback-prefix>/<deviceId>/directory?from=<ms>&to=<ms>[&profile=<p>]`
 *
 * `profile` is the one the client wants to PLAY (the tier plays `high`, a scrub
 * reads `low`). When the device does not record it, the availability pick is
 * served instead and the payload's `profile` field says so — the fallback is
 * visible, never silent.
 *
 * Same prefix, same auth and same fetch seam as the segment bytes: one plane,
 * one credential path. Deliberately NOT a tRPC procedure — the body is binary
 * and it belongs on the media plane's byte accounting. (When this was written
 * a cap method could not be added at all — the generated `AppRouter` sat at
 * TypeScript's expansion limit. That cliff was removed on 2026-07-30, when
 * `scripts/generate-api-types.ts` started deriving cap procedures from the Zod
 * definitions; the binary-body reason is the one that still holds.)
 *
 * Everything else on the prefix is delegated untouched to the file handler.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { encodeDirectory, type DirectoryRow, type SeededMfraTable } from '../segment-directory.js'

export interface DirectorySource {
  /** The profile to serve: the requested one when the device records it, else
   *  the availability pick, or null when the device records nothing. */
  servedProfileFor(deviceId: number, requested?: string): Promise<string | null>
  /**
   * Segments of one UTC hour, exact, from filenames — sizes included: the
   * client's byte-range URLs embed the size, so a wrong one is a 404.
   *
   * `complete` says whether every root was actually READ. Answering an hour is
   * itself the look — there is no separate hydration step — so an incomplete
   * scan (a root that threw) is the ONLY case the client must not cache: a
   * partial answer served as covered would turn that root's footage into a
   * permanent gap.
   */
  segmentsOfChecked(
    deviceId: number,
    profile: string,
    hourStartMs: number,
  ): Promise<{
    readonly segments: readonly { startMs: number; durMs: number; bytes: number }[]
    readonly complete: boolean
  }>
}

export interface DirectoryHandlerDeps {
  readonly source: DirectorySource
  /** The sync-sample table captured at finalize, when the recorder has one —
   *  carried per row so a seek needs no mfra tail fetch. */
  readonly mfraFor?: (
    deviceId: number,
    profile: string,
    startMs: number,
  ) => SeededMfraTable | undefined
  readonly now?: () => number
  readonly onLog?: (msg: string, data: Record<string, unknown>) => void
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** A window wider than this is refused: it is a client bug, and answering it
 *  would walk the archive on the read path — the thing this replaces. */
const MAX_WINDOW_MS = 32 * DAY_MS

/** `/<deviceId>/directory` — the rest of the prefix belongs to the file handler. */
const DIRECTORY_PATH = /^\/(\d+)\/directory$/

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * Wrap a file handler so the `/directory` path is answered from memory and
 * everything else falls through unchanged.
 */
export function withDirectoryRoute(deps: DirectoryHandlerDeps, next: NodeHandler): NodeHandler {
  return async (req, res) => {
    const raw = req.url ?? '/'
    const qs = raw.indexOf('?')
    const pathname = qs === -1 ? raw : raw.slice(0, qs)
    const match = DIRECTORY_PATH.exec(pathname)
    if (!match) {
      await next(req, res)
      return
    }

    const deviceId = Number(match[1])
    const params = new URLSearchParams(qs === -1 ? '' : raw.slice(qs + 1))
    const fromMs = Number(params.get('from'))
    const toMs = Number(params.get('to'))
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      res.statusCode = 400
      res.end('directory: from/to required')
      return
    }
    if (toMs - fromMs > MAX_WINDOW_MS) {
      res.statusCode = 400
      res.end('directory: window too wide')
      return
    }

    const requested = params.get('profile') ?? undefined

    try {
      const profile = await deps.source.servedProfileFor(deviceId, requested)
      if (profile === null) {
        // No profile ⟹ nothing recorded for this device, which is a REAL answer
        // and not an error — but it is only trustworthy once something looked.
        sendDirectory(res, { profile: '', hydrated: false, asOfMs: 0, rows: [] })
        return
      }

      const rows: DirectoryRow[] = []
      const firstHour = Math.floor(fromMs / HOUR_MS) * HOUR_MS
      // Answering IS the look: each hour is a real (cached) directory read, so
      // the window is hydrated unless one of those reads failed. Deriving this
      // from a separate scan cache made `hydrated:false` sticky, and the client
      // then re-fetched the directory on EVERY cursor move — one round trip per
      // scrub position, which is the stampede coverage exists to remove.
      let hydrated = true
      for (let hour = firstHour; hour < toMs; hour += HOUR_MS) {
        const { segments, complete } = await deps.source.segmentsOfChecked(deviceId, profile, hour)
        if (!complete) hydrated = false
        for (const s of segments) {
          if (s.startMs + s.durMs <= fromMs || s.startMs >= toMs) continue
          const mfra = deps.mfraFor?.(deviceId, profile, s.startMs)
          rows.push({
            startMs: s.startMs,
            durMs: s.durMs,
            bytes: s.bytes,
            ...(mfra ? { mfra } : {}),
          })
        }
      }
      rows.sort((a, b) => a.startMs - b.startMs)
      sendDirectory(res, {
        profile,
        hydrated,
        asOfMs: deps.now?.() ?? Date.now(),
        rows,
      })
      deps.onLog?.('directory:served', {
        deviceId,
        profile,
        requested: requested ?? null,
        rows: rows.length,
        hydrated,
      })
    } catch (err: unknown) {
      deps.onLog?.('directory:failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err),
      })
      res.statusCode = 500
      res.end('directory: failed')
    }
  }
}

function sendDirectory(res: ServerResponse, payload: Parameters<typeof encodeDirectory>[0]): void {
  const body = encodeDirectory(payload)
  res.statusCode = 200
  res.setHeader('content-type', 'application/octet-stream')
  res.setHeader('content-length', String(body.length))
  // Identity, stated. The hub's compressor has emptied bodies on forked routes
  // before, and a mangled directory is indistinguishable from an empty archive.
  res.setHeader('content-encoding', 'identity')
  // The past cannot change but by eviction; the caller re-asks for the live
  // edge, so a short shared cache is safe and a long one is not.
  res.setHeader('cache-control', 'private, max-age=2')
  res.end(Buffer.from(body))
}
