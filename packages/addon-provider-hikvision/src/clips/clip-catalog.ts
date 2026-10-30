/**
 * The camera's catalog: what it HOLDS, and whether it can say.
 *
 * Three ISAPI reads, in the order their cost says (D54 — the cheap question
 * first):
 *
 * 1. `GET /ISAPI/ContentMgmt/Storage` — is there a card at all. Milliseconds,
 *    and it turns "no clips" into "no card", which is a different sentence and
 *    a different operator action. It works on 100 % of this fleet.
 * 2. `GET /ISAPI/ContentMgmt/record/tracks` — what the archive IS. The only
 *    honest source for the codec (`search` says `H.264-BP` for H.265 media)
 *    and for how many tracks exist (one, on 1436).
 * 3. `POST /ISAPI/ContentMgmt/search` — the rows, PAGED.
 *
 * ## Free space is NOT a proxy for "has footage"
 *
 * 1436 and 1439 both report 11776 MB free — 11.5 GiB exactly — because that is
 * the fixed loop reserve a card converges on once `LoopEnable` has wrapped.
 * 3833 reports 128000 MB only because it has not wrapped yet. A camera at loop
 * steady state reports the same number whether it recorded yesterday or
 * stopped a month ago. **Availability is answered by a SEARCH, never by
 * `freeSpace`** — which is why `readStorageState` answers `present` and
 * `absent` and never "full" or "empty".
 *
 * ## `framerate` is not read
 *
 * `record/tracks` declares `framerate=2.260000 fps` on a track measured at
 * 12.55. The field is parsed into nothing. The rate a clip is muxed at is
 * measured from the replay's own RTP timestamps (`clip-replay-rate.ts`).
 */

import { randomBytes } from 'node:crypto'
import type { IScopedLogger } from '@camstack/types'

import type { HikvisionIsapiClient } from '../hikvision-isapi-client.js'
import { clipKeyFor } from './clip-identity.js'
import {
  buildClipSearchBody,
  type ClipSearchItem,
  clipSearchIsComplete,
  parseClipSearchPage,
} from './clip-search.js'

/** How many rows one `search` page asks for. The camera caps its own page —
 *  measured at 40 when 40 was asked and at 10 when 10 was — so this is a
 *  request, and {@link CLIP_SEARCH_MAX_PAGES} is what bounds the work. */
export const CLIP_SEARCH_PAGE_SIZE = 40

/**
 * How many pages one listing may walk.
 *
 * 40 pages is 1600 rows, far past any window a surface asks for, and it is a
 * BOUND rather than a budget: a camera whose paging never says `OK` would
 * otherwise loop for ever, and the honest answer to that is a listing that
 * stops and says it stopped.
 */
export const CLIP_SEARCH_MAX_PAGES = 40

/** One row of a Hikvision camera's own catalog. */
export interface HikvisionClipRow {
  readonly clipKey: string
  readonly trackId: number
  readonly fileName: string
  readonly startMs: number
  readonly endMs: number
  /** The camera's opaque playback handle — path and query, verbatim. */
  readonly playbackPath: string
  /** The size the camera listed for the file, when it listed one. */
  readonly sizeBytes?: number
  /** `motion`, `timing`, … — the camera's OWN words, unmapped. */
  readonly recordTypes: readonly string[]
}

export type ClipStorageState =
  /** A card is mounted and readable. */
  | { readonly kind: 'present'; readonly capacityMb: number; readonly freeMb: number }
  /** No card, or every card unusable. The reason `no-storage` exists. */
  | { readonly kind: 'absent'; readonly reason: string }
  /**
   * The question was not ANSWERED. Never folded into either of the above: a
   * measurement that failed is not a measurement (D393), and folding an
   * unreadable storage read into "the card is fine" is how a camera with no
   * card answers `ok` and then an empty list.
   */
  | { readonly kind: 'unknown'; readonly reason: string }

function tagOf(xml: string, tag: string): string | undefined {
  return new RegExp(`<(?:[\\w.-]+:)?${tag}[^>]*>([^<]*)</`, 'i').exec(xml)?.[1]?.trim()
}

/**
 * Is there anything to list ON?
 *
 * The `hdd` rows are the camera's own words. A row whose `status` is not `ok`
 * is not storage a recording can be read from, and a camera with no rows at
 * all has no card — which is 1441 and 3831 on this fleet, both of them
 * scheduled to record to a card that is not there.
 */
export async function readStorageState(client: HikvisionIsapiClient): Promise<ClipStorageState> {
  let xml: string
  try {
    xml = await client.getText('/ISAPI/ContentMgmt/Storage')
  } catch (err: unknown) {
    return { kind: 'unknown', reason: err instanceof Error ? err.message : String(err) }
  }
  const rows = [...xml.matchAll(/<(?:[\w.-]+:)?hdd[\s>][\s\S]*?<\/(?:[\w.-]+:)?hdd>/gi)].map(
    (match) => match[0],
  )
  if (rows.length === 0) {
    return { kind: 'absent', reason: 'The camera reports no storage device (empty hddList).' }
  }
  for (const row of rows) {
    const status = (tagOf(row, 'status') ?? '').toLowerCase()
    if (status !== 'ok') continue
    return {
      kind: 'present',
      capacityMb: Number(tagOf(row, 'capacity') ?? '0'),
      freeMb: Number(tagOf(row, 'freeSpace') ?? '0'),
    }
  }
  const states = rows.map((row) => tagOf(row, 'status') ?? 'unknown')
  return {
    kind: 'absent',
    reason: `The camera reports ${String(rows.length)} storage device(s), none of them ok (${states.join(', ')}).`,
  }
}

/** One archived track, as `record/tracks` describes it. */
export interface ClipTrackInfo {
  readonly id: number
  readonly enabled: boolean
  /** From `Description`'s `codecType=` — right where `search` is wrong. */
  readonly codec: string | undefined
  readonly resolution: string | undefined
  /**
   * The camera calls this track a VIDEO one.
   *
   * Measured: 3833 lists tracks 101 AND 103, and only 101 carries
   * `trackType=video`; 1436 lists 101 alone. Taking "the first enabled track"
   * would therefore read one camera's catalog on a track that holds no
   * picture, on a fleet where the two cameras are the same model family. The
   * camera's own word for what a track IS costs nothing to read and is the
   * only thing that distinguishes them.
   */
  readonly isVideo: boolean
}

/**
 * The tracks the camera ARCHIVES.
 *
 * Read once per availability probe, never per clip. Its job is to say how many
 * copies of a recording exist — which on this fleet is one — and what the
 * media really is. A `DESCRIBE` is never used for either: track 102 answers
 * 200 with a 720p SDP and delivers the 4K main stream, which is the exact
 * shape of a silent 33x substitution.
 */
export async function readArchivedTracks(
  client: HikvisionIsapiClient,
): Promise<readonly ClipTrackInfo[]> {
  const xml = await client.getText('/ISAPI/ContentMgmt/record/tracks')
  const out: ClipTrackInfo[] = []
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?Track[\s>][\s\S]*?<\/(?:[\w.-]+:)?Track>/gi)) {
    const block = match[0]
    const id = Number(tagOf(block, 'id') ?? '')
    if (!Number.isInteger(id)) continue
    const description = tagOf(block, 'Description') ?? ''
    out.push({
      id,
      enabled: (tagOf(block, 'Enable') ?? '').toLowerCase() === 'true',
      codec: /codecType=([^,]+)/.exec(description)?.[1]?.trim(),
      resolution: /resolution=([^,]+)/.exec(description)?.[1]?.trim(),
      isVideo: /trackType=video/.test(description),
    })
  }
  return out
}

export interface ListClipRowsInput {
  readonly trackId: number
  readonly sinceMs: number
  readonly untilMs: number
  readonly logger: IScopedLogger
  readonly deviceId: number
}

export type ListClipRowsOutcome =
  | { readonly kind: 'ok'; readonly rows: readonly HikvisionClipRow[]; readonly pages: number }
  /** The camera answered something this provider could not read. */
  | { readonly kind: 'refused'; readonly detail: string }

function toRow(item: ClipSearchItem): HikvisionClipRow {
  return {
    clipKey: clipKeyFor(item.trackId, item.fileName),
    trackId: item.trackId,
    fileName: item.fileName,
    startMs: item.startMs,
    endMs: item.endMs,
    playbackPath: item.playbackPath,
    ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
    recordTypes: item.recordTypes,
  }
}

/**
 * Every row in a window, paged to the end.
 *
 * Paging is not an optimisation, it is the difference between the answer and a
 * prefix of it: results are OLDEST first and one page is capped, so a listing
 * that stops after the first page hands the operator yesterday's footage and
 * nothing since. The terminator is `responseStatusStrg`, never
 * `numOfMatches`, which is the size of the page in hand.
 */
export async function listClipRows(
  client: HikvisionIsapiClient,
  input: ListClipRowsInput,
): Promise<ListClipRowsOutcome> {
  const tags = { deviceId: input.deviceId }
  // One search id for the whole walk: the camera keys its cursor on it.
  const searchId = `{${randomBytes(16).toString('hex').toUpperCase()}}`
  const rows: HikvisionClipRow[] = []
  let position = 0
  for (let page = 0; page < CLIP_SEARCH_MAX_PAGES; page += 1) {
    let xml: string
    try {
      xml = await client.postXml(
        '/ISAPI/ContentMgmt/search',
        buildClipSearchBody({
          searchId,
          trackId: input.trackId,
          sinceMs: input.sinceMs,
          untilMs: input.untilMs,
          maxResults: CLIP_SEARCH_PAGE_SIZE,
          position,
        }),
      )
    } catch (err: unknown) {
      return { kind: 'refused', detail: err instanceof Error ? err.message : String(err) }
    }
    const parsed = parseClipSearchPage(xml)
    if (parsed.status === 'unknown') {
      // Not an empty day: a body this provider could not read. Answering `[]`
      // here would be "this camera has no recordings", which is a guess.
      return {
        kind: 'refused',
        detail:
          'the camera answered a search result this provider could not read ' +
          `(no responseStatusStrg in ${String(xml.length)} bytes)`,
      }
    }
    rows.push(...parsed.items.map(toRow))
    if (clipSearchIsComplete(parsed)) {
      return { kind: 'ok', rows, pages: page + 1 }
    }
    // A page that says MORE and carried nothing would otherwise page for ever
    // against the same cursor.
    if (parsed.items.length === 0) {
      input.logger.warn('videoclips: a search page said MORE and carried nothing', {
        tags,
        meta: { branch: 'search-empty-page', page, position },
      })
      return { kind: 'ok', rows, pages: page + 1 }
    }
    position += parsed.pageSize > 0 ? parsed.pageSize : parsed.items.length
  }
  input.logger.warn('videoclips: a search never said it was complete — stopping at the bound', {
    tags,
    meta: { branch: 'search-page-bound', pages: CLIP_SEARCH_MAX_PAGES, rows: rows.length },
  })
  return { kind: 'ok', rows, pages: CLIP_SEARCH_MAX_PAGES }
}
