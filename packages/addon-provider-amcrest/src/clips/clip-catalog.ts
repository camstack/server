/**
 * The camera's catalog — the `mediaFileFind` walk, and the one question it
 * cannot answer on its own.
 *
 * ## The walk
 *
 * `factory.create` → `findFile` → `findNextFile` until `found < count` →
 * `close` → `destroy`. Four traps, all measured on device 3836 (2026-09-23),
 * and each of them produces a confidently wrong answer if missed:
 *
 * 1. **`findFile`'s own `result` is the only gate.** After a `findFile` that
 *    FAILED (code 285409284, empty message), `findNextFile` answers
 *    `{"result":true,"found":0,"infos":null}` — a clean, authoritative-looking
 *    "this camera has no clips" from a search that never ran.
 * 2. **`getCount` is never called.** 501 over CGI; over RPC2 it answers
 *    `{"count":0,"result":true}` on an object that then enumerates rows.
 * 3. **`factory.destroy` is `Method not found`.** `close` and `destroy` — the
 *    methods on the OBJECT — both answer `true`, and both are sent, in a
 *    `finally`, or a find object leaks per search.
 * 4. **`Types: ["dav"]`** — without it, 45 of 60 rows are single JPEGs.
 *    See `clip-search.ts`.
 *
 * ## The question the walk cannot answer, and the control search that does
 *
 * **An EMPTY WINDOW and a MALFORMED search are the same refusal.** Measured
 * four ways, all of them `result: false, code 285409284, message ""`:
 *
 * | condition | what it really is |
 * | --- | --- |
 * | `Channel: 99`, garbage times | malformed |
 * | `Channel: 1` (this camera has only 0) | malformed |
 * | `Flags: ["Timing"]` on an event-only card | nothing matched |
 * | 2026-09-22, a day with no footage | **nothing matched** |
 *
 * So gating on `findFile.result` alone — which trap 1 says you must — turns
 * every quiet day into `unreachable`, and a surface would draw "this camera
 * could not be reached" over an ordinary empty Tuesday. That is D315's rule
 * inverted: not-yet-known must not look like not-installed, and here a plain
 * ABSENCE was about to look like a fault.
 *
 * The discriminator is a CONTROL search this provider builds itself, over an
 * unbounded window, in the same shape as the real one. Measured three times at
 * 361–384 ms:
 *
 * - control answers → the camera and our condition shape are both fine, so the
 *   narrow refusal means **the window is empty**. Answer `[]`, and say so.
 * - control refuses too → the camera's index answers nothing ANYWHERE while
 *   its storage reads healthy. That is `index-empty`: a defect on the camera,
 *   and the only honest thing to report is which two windows were asked.
 *
 * It costs one extra RPC pair, ONLY on the refusal path, and never on a
 * listing that found something.
 */
import type { IScopedLogger } from '@camstack/types'

import type { AmcrestRpc2Client, AmcrestRpc2Error } from './amcrest-rpc2-client.js'
import { toCameraWallClock, type AmcrestCameraClock } from './clip-clock.js'
import {
  buildFindCondition,
  CLIP_FIND_MAX_PAGES,
  CLIP_FIND_PAGE_SIZE,
  findWalkIsComplete,
  parseClipRow,
  type AmcrestClipRow,
  type ClipRowRejection,
} from './clip-search.js'

/**
 * The control window — the camera's own wall clock, wide enough that no card
 * can fall outside it. Measured accepted on this firmware (`findFile` true in
 * 361 ms).
 */
export const CLIP_CONTROL_WINDOW = {
  start: '1970-01-01 00:00:00',
  end: '2100-01-01 00:00:00',
} as const

export interface ClipCatalogDeps {
  readonly rpc: AmcrestRpc2Client
  readonly logger: IScopedLogger
  readonly deviceId: number
}

export interface ReadClipRowsInput {
  /** 0-based, as `mediaFileFind` counts. */
  readonly channel: number
  readonly sinceMs: number
  readonly untilMs: number
  readonly clock: AmcrestCameraClock
}

/** How many rows the camera sent that did not become clips, by reason. Always
 *  reported: a branch that drops work says so (D391). */
export type ClipRowRejections = Readonly<Partial<Record<ClipRowRejection, number>>>

export type ReadClipRowsOutcome =
  | {
      readonly kind: 'ok'
      readonly rows: readonly AmcrestClipRow[]
      readonly pages: number
      readonly rejected: ClipRowRejections
      readonly rejectedCount: number
    }
  /** The camera answers searches, and this window holds nothing. A real,
   *  complete, empty answer — the source stays `ok`. */
  | { readonly kind: 'empty-window' }
  /** The camera refused the asked window AND the unbounded control. */
  | { readonly kind: 'index-empty'; readonly detail: string }
  /** The camera did not answer at all. */
  | { readonly kind: 'unreachable'; readonly detail: string }

function describeError(error: AmcrestRpc2Error): string {
  const code = error.code === null ? 'no code' : `code ${String(error.code)}`
  return error.message === '' ? `${code}, no message` : `${code}: ${error.message}`
}

/** What one find-object lifecycle produced. */
type SearchOutcome =
  | {
      readonly kind: 'ok'
      readonly rows: readonly AmcrestClipRow[]
      readonly pages: number
      readonly rejected: ClipRowRejections
      readonly rejectedCount: number
    }
  | { readonly kind: 'refused'; readonly detail: string }
  | { readonly kind: 'unreachable'; readonly detail: string }

interface RunSearchInput {
  readonly startWallClock: string
  readonly endWallClock: string
  readonly channel: number
  readonly clock: AmcrestCameraClock
  /** A control search only needs `findFile`'s verdict, so it never pages. */
  readonly enumerate: boolean
}

async function runSearch(deps: ClipCatalogDeps, input: RunSearchInput): Promise<SearchOutcome> {
  const tags = { deviceId: deps.deviceId }
  const created = await deps.rpc.call('mediaFileFind.factory.create', null)
  if (created.kind === 'unreachable') return { kind: 'unreachable', detail: created.detail }
  if (created.kind === 'refused') {
    return {
      kind: 'unreachable',
      detail: `the camera refused a find object (${describeError(created.error)})`,
    }
  }
  const handle = created.result
  if (typeof handle !== 'number' || !Number.isFinite(handle)) {
    return {
      kind: 'unreachable',
      detail: 'the camera answered a find-object handle this provider could not read',
    }
  }

  try {
    const condition = buildFindCondition({
      channel: input.channel,
      startWallClock: input.startWallClock,
      endWallClock: input.endWallClock,
    })
    const started = await deps.rpc.call('mediaFileFind.findFile', { condition }, handle)
    if (started.kind === 'unreachable') return { kind: 'unreachable', detail: started.detail }
    if (started.kind === 'refused') {
      // THE gate. Everything after this point would answer cleanly with
      // nothing, which is why this branch is the only one that decides.
      return { kind: 'refused', detail: describeError(started.error) }
    }
    if (!input.enumerate) {
      return { kind: 'ok', rows: [], pages: 0, rejected: {}, rejectedCount: 0 }
    }

    const rows: AmcrestClipRow[] = []
    const rejected: Partial<Record<ClipRowRejection, number>> = {}
    let rejectedCount = 0
    let pages = 0
    for (; pages < CLIP_FIND_MAX_PAGES; ) {
      const page = await deps.rpc.call(
        'mediaFileFind.findNextFile',
        { count: CLIP_FIND_PAGE_SIZE },
        handle,
      )
      pages += 1
      if (page.kind === 'unreachable') return { kind: 'unreachable', detail: page.detail }
      if (page.kind === 'refused') {
        return {
          kind: 'unreachable',
          detail: `page ${String(pages)} of the search refused (${describeError(page.error)})`,
        }
      }
      const foundRaw = page.params['found']
      const found = typeof foundRaw === 'number' && Number.isFinite(foundRaw) ? foundRaw : 0
      const infos = page.params['infos']
      const list = Array.isArray(infos) ? infos : []
      for (const raw of list) {
        const parsed = parseClipRow(raw, input.clock)
        if (parsed.kind === 'ok') {
          rows.push(parsed.row)
          continue
        }
        rejected[parsed.reason] = (rejected[parsed.reason] ?? 0) + 1
        rejectedCount += 1
      }
      if (findWalkIsComplete(found, CLIP_FIND_PAGE_SIZE)) break
      if (list.length === 0) {
        // A page that claimed MORE and carried nothing would otherwise page
        // for ever against the same cursor.
        deps.logger.warn('videoclips: a search page claimed more rows and carried none', {
          tags,
          meta: { branch: 'find-empty-page', page: pages, found },
        })
        break
      }
    }
    if (pages >= CLIP_FIND_MAX_PAGES) {
      deps.logger.warn('videoclips: a search never terminated — stopping at the page bound', {
        tags,
        meta: { branch: 'find-page-bound', pages, rows: rows.length },
      })
    }
    return { kind: 'ok', rows, pages, rejected, rejectedCount }
  } finally {
    // `factory.destroy` is `Method not found!` on this firmware; `close` and
    // `destroy` on the OBJECT both answer true, and both are sent. A find
    // object that is never released is a leak per search.
    await releaseFindObject(deps, handle)
  }
}

async function releaseFindObject(deps: ClipCatalogDeps, handle: number): Promise<void> {
  for (const method of ['mediaFileFind.close', 'mediaFileFind.destroy'] as const) {
    const released = await deps.rpc.call(method, null, handle)
    if (released.kind === 'ok') continue
    // A release that failed leaks one object on the camera. It is not worth
    // failing a listing that otherwise worked, and it IS worth a line: the
    // symptom of losing this silently is a camera that stops accepting
    // searches days later for no visible reason.
    deps.logger.warn('videoclips: a find object was not released', {
      tags: { deviceId: deps.deviceId },
      meta: {
        branch: 'find-object-leak',
        method,
        detail: released.kind === 'refused' ? describeError(released.error) : released.detail,
      },
    })
  }
}

/**
 * Every row the camera holds in a window.
 *
 * The window travels as the CAMERA's wall clock, converted through the
 * measured offset. A UTC window would be two hours off in summer and one in
 * winter, and would silently return the wrong footage rather than an error.
 */
export async function readClipRows(
  deps: ClipCatalogDeps,
  input: ReadClipRowsInput,
): Promise<ReadClipRowsOutcome> {
  const tags = { deviceId: deps.deviceId }
  const startWallClock = toCameraWallClock(input.sinceMs, input.clock)
  const endWallClock = toCameraWallClock(input.untilMs, input.clock)
  const asked = await runSearch(deps, {
    startWallClock,
    endWallClock,
    channel: input.channel,
    clock: input.clock,
    enumerate: true,
  })
  if (asked.kind === 'ok') {
    if (asked.rejectedCount > 0) {
      deps.logger.warn('videoclips: the camera sent rows this provider could not read', {
        tags,
        meta: {
          branch: 'rows-rejected',
          rejected: asked.rejected,
          rejectedCount: asked.rejectedCount,
          kept: asked.rows.length,
        },
      })
    }
    return asked
  }
  if (asked.kind === 'unreachable') return { kind: 'unreachable', detail: asked.detail }

  // The refusal is ambiguous by construction. One control search settles it.
  const control = await runSearch(deps, {
    startWallClock: CLIP_CONTROL_WINDOW.start,
    endWallClock: CLIP_CONTROL_WINDOW.end,
    channel: input.channel,
    clock: input.clock,
    enumerate: false,
  })
  if (control.kind === 'unreachable') {
    return {
      kind: 'unreachable',
      detail:
        `the camera refused the search for ${startWallClock} … ${endWallClock} ` +
        `(${asked.detail}) and did not answer the control search (${control.detail})`,
    }
  }
  if (control.kind === 'ok') {
    // The camera answers searches in this exact shape. The narrow one found
    // nothing, which is an ANSWER and not a fault.
    deps.logger.info('videoclips: the window holds nothing, proved against a control search', {
      tags,
      meta: {
        branch: 'empty-window',
        startWallClock,
        endWallClock,
        refusal: asked.detail,
      },
    })
    return { kind: 'empty-window' }
  }
  return {
    kind: 'index-empty',
    detail:
      `the camera refused both the asked window (${startWallClock} … ${endWallClock}: ` +
      `${asked.detail}) and an unbounded control search (${CLIP_CONTROL_WINDOW.start} … ` +
      `${CLIP_CONTROL_WINDOW.end}: ${control.detail}) — its index answers nothing anywhere`,
  }
}
