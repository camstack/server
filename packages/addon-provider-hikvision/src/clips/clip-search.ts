/**
 * `POST /ISAPI/ContentMgmt/search` — building the ask, and reading the answer.
 *
 * Pure. Everything here was measured against 1436 and 3833 on 2026-09-22, and
 * three of the rules exist because the hardware contradicts its own 2014 RaCM
 * specification.
 *
 * ## 1. `responseStatus` is `true` for NO MATCHES
 *
 * The specification and every OSS client say `false`, and warn against
 * treating it as an error. Here a parser written to the documentation turns a
 * genuinely empty day into a failure — the absent-vs-unknown confusion D315
 * exists to prevent. **This parser never reads `responseStatus`.** It reads
 * `responseStatusStrg`, which is `OK`, `MORE` or `NO MATCHES`.
 *
 * ## 2. `numOfMatches` is the size of THIS PAGE, not of the result
 *
 * Measured on 1436: a 48-hour window answered 40, 40 and 6 across three pages
 * with `MORE`, `MORE`, `OK`; with `maxResults: 10` it answered ten pages of
 * ten. So a caller that reads `numOfMatches` as a total, or that stops when it
 * has as many rows as it asked for, is answering with a prefix of the OLDEST
 * footage and no indication that it did. {@link clipSearchIsComplete} is the
 * only terminator, and it keys off `MORE`.
 *
 * ## 3. `codecType` LIES
 *
 * It says `H.264-BP` for media whose SDP says `H265/90000`, whose RTP payloads
 * carry a VPS (a NAL type that does not exist in H.264 at all) and which
 * ffprobe calls `hevc`. It is parsed so the row can carry what the camera
 * CLAIMED, and nothing decodes from it.
 *
 * Also measured: results come back OLDEST first; both the vendor's misspelling
 * `searchResultPostion` and the correct spelling are accepted (the misspelling
 * is sent, because it is the one the firmware's own documentation uses and the
 * one every camera takes); the namespace is `std-cgi.com/ver20`, so every tag
 * here is read namespace-agnostically.
 */

/** The `responseStatusStrg` values this firmware answers. */
export type ClipSearchStatus = 'ok' | 'more' | 'no-matches' | 'unknown'

export interface ClipSearchItem {
  /** `trackID` — 101 on this fleet, the only archived track. */
  readonly trackId: number
  /** UTC epoch ms, from `timeSpan/startTime`. */
  readonly startMs: number
  readonly endMs: number
  /**
   * The camera's own playback handle: path AND query of `playbackURI`.
   *
   * Opaque. The `name` counter inside it is monotonic and rolls, so the whole
   * string is the identity of the media and nothing composes one.
   */
  readonly playbackPath: string
  /** `name=` out of the URI — the file id the camera uses. */
  readonly fileName: string
  /** `size=` out of the URI, when it carried one. */
  readonly sizeBytes?: number
  /** `recordType.meta.std-cgi.com/<type>` — `motion`, `timing`, … */
  readonly recordTypes: readonly string[]
  /** What `search` CLAIMED the codec is. Never decoded from (see above). */
  readonly declaredCodec?: string
}

export interface ClipSearchPage {
  readonly status: ClipSearchStatus
  /** Oldest first, exactly as the camera ordered them. */
  readonly items: readonly ClipSearchItem[]
  /** `numOfMatches` — the size of THIS page. */
  readonly pageSize: number
}

export interface ClipSearchAsk {
  readonly searchId: string
  readonly trackId: number
  readonly sinceMs: number
  readonly untilMs: number
  readonly maxResults: number
  readonly position: number
}

/**
 * Hikvision's stamp format: `20260922T063105Z` in a URI, `2026-09-22T06:31:05Z`
 * in XML. Both are UTC and neither carries milliseconds.
 */
function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function buildClipSearchBody(ask: ClipSearchAsk): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<CMSearchDescription>' +
    `<searchID>${ask.searchId}</searchID>` +
    `<trackList><trackID>${String(ask.trackId)}</trackID></trackList>` +
    '<timeSpanList><timeSpan>' +
    `<startTime>${isoUtc(ask.sinceMs)}</startTime>` +
    `<endTime>${isoUtc(ask.untilMs)}</endTime>` +
    '</timeSpan></timeSpanList>' +
    `<maxResults>${String(ask.maxResults)}</maxResults>` +
    // The vendor's misspelling. Both are accepted by this firmware; this is
    // the one its own documentation uses and the one older units take.
    `<searchResultPostion>${String(ask.position)}</searchResultPostion>` +
    '<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>' +
    '</CMSearchDescription>'
  )
}

/** One tag's text, ignoring any namespace prefix. */
function tagOf(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<(?:[\\w.-]+:)?${tag}[^>]*>([^<]*)</`, 'i').exec(xml)
  return match?.[1]?.trim()
}

function allTagsOf(xml: string, tag: string): readonly string[] {
  return [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${tag}[^>]*>([^<]*)</`, 'gi'))].map((m) =>
    (m[1] ?? '').trim(),
  )
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
}

function statusOf(raw: string | undefined): ClipSearchStatus {
  switch ((raw ?? '').toUpperCase()) {
    case 'OK':
      return 'ok'
    case 'MORE':
      return 'more'
    case 'NO MATCHES':
    case 'NOMATCHES':
      return 'no-matches'
    default:
      return 'unknown'
  }
}

/** `2026-09-22T06:31:05Z` → epoch ms. `null` for anything unparseable. */
function stampMs(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Parse one page of `CMSearchResult`.
 *
 * Never throws. A body this parser cannot read answers `unknown` with no
 * items, which the caller reports as the camera being unreachable — the one
 * thing it must never do is answer `ok` with an empty list, because that is
 * "this camera has no recordings" and it would be a guess.
 */
export function parseClipSearchPage(xml: string): ClipSearchPage {
  const status = statusOf(tagOf(xml, 'responseStatusStrg'))
  const pageSize = Number(tagOf(xml, 'numOfMatches') ?? '0')
  const items: ClipSearchItem[] = []
  // `<matchList>\r\n</matchList>` — an empty list is real on this firmware,
  // not folklore, and it arrives beside `NO MATCHES`.
  for (const match of xml.matchAll(
    /<(?:[\w.-]+:)?searchMatchItem[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?searchMatchItem>/gi,
  )) {
    const block = match[1] ?? ''
    const startMs = stampMs(tagOf(block, 'startTime'))
    const endMs = stampMs(tagOf(block, 'endTime'))
    const uri = tagOf(block, 'playbackURI')
    if (startMs === null || endMs === null || uri === undefined || uri === '') continue
    const decoded = unescapeXml(uri)
    const scheme = decoded.indexOf('://')
    if (scheme === -1) continue
    const afterHost = decoded.indexOf('/', scheme + 3)
    if (afterHost === -1) continue
    const playbackPath = decoded.slice(afterHost)
    const fileName = /[?&]name=([^&]*)/.exec(playbackPath)?.[1]
    if (fileName === undefined || fileName === '') continue
    const size = Number(/[?&]size=(\d+)/.exec(playbackPath)?.[1] ?? '')
    const trackId = Number(tagOf(block, 'trackID') ?? '')
    const declaredCodec = tagOf(block, 'codecType')
    items.push({
      trackId: Number.isInteger(trackId) ? trackId : 0,
      startMs,
      endMs,
      playbackPath,
      fileName,
      ...(Number.isFinite(size) && size > 0 ? { sizeBytes: size } : {}),
      recordTypes: allTagsOf(block, 'metadataDescriptor')
        .map((descriptor) => descriptor.split('/').at(-1) ?? '')
        .filter((type) => type !== '' && !type.includes('.')),
      ...(declaredCodec !== undefined && declaredCodec !== '' ? { declaredCodec } : {}),
    })
  }
  return { status, items, pageSize }
}

/**
 * Is this page the LAST one?
 *
 * `MORE` is the only value that means "ask again". `unknown` stops too: a
 * status this parser could not read is not a licence to page for ever against
 * a camera that is answering something we do not understand.
 */
export function clipSearchIsComplete(page: ClipSearchPage): boolean {
  return page.status !== 'more'
}
