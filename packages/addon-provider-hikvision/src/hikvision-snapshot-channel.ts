/**
 * Which ISAPI streaming channel a Hikvision snapshot is taken from.
 *
 * Two concerns, both pure, both here rather than inline in the ISAPI client or
 * the camera:
 *
 * 1. **Element-scoped reads of a streaming-channel document.** The document
 *    carries more than one `<enabled>`, and the FIRST one is the whole
 *    channel's on/off switch:
 *
 *    ```xml
 *    <StreamingChannel>
 *      <id>101</id>
 *      <channelName>Camera 01</channelName>
 *      <enabled>true</enabled>        <!-- the CHANNEL -->
 *      <Video><enabled>true</enabled>…</Video>
 *      <Audio><enabled>true</enabled>…</Audio>
 *    </StreamingChannel>
 *    ```
 *
 *    A regex that matches the first `<enabled>` gets the right answer only
 *    because of the order this firmware happens to emit — reorder the document,
 *    or ask a firmware that puts `<Video>` first, and the same code silently
 *    reports the video sub-element's flag as the channel's. `readDirectChildText`
 *    walks tag depth and answers only for a DIRECT child, so the order stops
 *    mattering. Same trap already recorded for `<Audio><enabled>` in
 *    `hikvision-stream-audio.ts`.
 *
 * 2. **Resolving the operator's channel choice.** The default is the channel the
 *    provider used before this setting existed — an untouched camera must not
 *    change behaviour on upgrade — and a stored choice the camera no longer
 *    enumerates falls back to that default rather than 404ing every snapshot.
 *    The caller LOGS that fallback: silently swapping a channel is exactly the
 *    kind of dropped work that reads as "never happened".
 */

/** One `<StreamingChannel>` as it appears in `/ISAPI/Streaming/channels`. */
export interface StreamingChannelSummary {
  /** Channel id as Hikvision encodes it: `101`, `102`, `201`, … */
  readonly channelId: string
  /** `<channelName>`, when the firmware emits one. */
  readonly channelName: string | null
  /** The CHANNEL's own `<enabled>` — never `<Video>`'s or `<Audio>`'s. */
  readonly enabled: boolean
}

/** An operator-selectable snapshot source, ready for a `select` field. */
export interface SnapshotChannelOption {
  readonly value: string
  readonly label: string
}

/** Where the effective snapshot channel came from. Drives whether we log. */
export type SnapshotChannelSource =
  /** Nothing stored — the provider's historical channel. */
  | 'default'
  /** The operator's stored choice, and the camera offers it. */
  | 'operator'
  /** The operator's stored choice is not among the channels the camera
   *  enumerates — we fell back to the default and the caller must say so. */
  | 'fallback-unknown'

export interface SnapshotChannelResolution {
  readonly channelId: string
  readonly source: SnapshotChannelSource
}

/** Descriptor of a probed channel, as persisted in `deviceCache.streamSnapshots`. */
export interface SnapshotChannelDescriptor {
  readonly channelId: string
  readonly channelName?: string | null
  readonly enabled?: boolean | undefined
  readonly codec?: string | null
  readonly width?: number | null
  readonly height?: number | null
}

/**
 * Hikvision encodes a channel id as `{cameraNumber}{streamSlot}`; slot `1` is
 * the main stream. The provider has always taken its snapshot from the main
 * stream of the device's camera number, and that stays the default.
 */
export function defaultSnapshotChannelId(cameraNumber: number): string {
  return `${cameraNumber}01`
}

/** Human name for a stream slot, for the select label. */
function streamSlotLabel(channelId: string): string {
  const slot = channelId.slice(-1)
  if (slot === '1') return 'Main stream'
  if (slot === '2') return 'Sub stream'
  if (slot === '3') return 'Third stream'
  return `Stream ${slot}`
}

interface TagToken {
  readonly name: string
  readonly closing: boolean
  readonly selfClosing: boolean
  /** Index of `<` in the source. */
  readonly start: number
  /** Index just past `>` in the source. */
  readonly end: number
}

/**
 * Tag scanner. `<?xml …?>`, `<!-- … -->` and `<![CDATA[…]]>` never match —
 * `?`, `!` are outside the name class — so they are skipped as text.
 */
function* scanTags(xml: string): Generator<TagToken> {
  const re = /<(\/?)\s*([A-Za-z_][A-Za-z0-9_.:-]*)([^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const rawName = m[2] ?? ''
    const colon = rawName.lastIndexOf(':')
    yield {
      name: (colon >= 0 ? rawName.slice(colon + 1) : rawName).toLowerCase(),
      closing: m[1] === '/',
      selfClosing: (m[3] ?? '').trimEnd().endsWith('/'),
      start: m.index,
      end: re.lastIndex,
    }
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Text of the first `<tag>` that is a DIRECT child of `elementInner`.
 *
 * `null` when the element has no such direct child — a nested occurrence
 * (`<Video><enabled>`) is deliberately invisible here. Empty string when the
 * direct child exists but is empty or self-closing, which is NOT the same
 * answer and callers must keep the two apart.
 */
export function readDirectChildText(elementInner: string, tag: string): string | null {
  const want = tag.toLowerCase()
  let depth = 0
  let openedAt = -1
  for (const token of scanTags(elementInner)) {
    if (token.selfClosing) {
      if (depth === 0 && !token.closing && token.name === want) return ''
      continue
    }
    if (token.closing) {
      if (depth === 1 && openedAt >= 0 && token.name === want) {
        return decodeXmlEntities(elementInner.slice(openedAt, token.start).trim())
      }
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && token.name === want && openedAt < 0) openedAt = token.end
    depth += 1
  }
  return null
}

/**
 * Inner content of the first `<tag>…</tag>` element in `xml`, or `null`.
 * Used to reach INTO a `<StreamingChannel>` before asking for a direct child.
 */
export function extractElementInner(xml: string, tag: string): string | null {
  const want = tag.toLowerCase()
  let depth = 0
  let openedAt = -1
  for (const token of scanTags(xml)) {
    if (token.selfClosing) {
      if (depth === 0 && !token.closing && token.name === want) return ''
      continue
    }
    if (token.closing) {
      if (depth === 1 && openedAt >= 0 && token.name === want) {
        return xml.slice(openedAt, token.start)
      }
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && token.name === want && openedAt < 0) openedAt = token.end
    depth += 1
  }
  return null
}

/**
 * Every `<StreamingChannel>` element's inner content, in document order.
 * Depth-aware, so a `<StreamingChannelList>` wrapper is transparent and a
 * (hypothetical) nested repeat is not double-counted.
 */
function streamingChannelBlocks(xml: string): readonly string[] {
  const out: string[] = []
  let depth = 0
  let openedAt = -1
  let openDepth = -1
  for (const token of scanTags(xml)) {
    if (token.selfClosing) continue
    if (token.closing) {
      depth = Math.max(0, depth - 1)
      if (openedAt >= 0 && depth === openDepth && token.name === 'streamingchannel') {
        out.push(xml.slice(openedAt, token.start))
        openedAt = -1
        openDepth = -1
      }
      continue
    }
    if (openedAt < 0 && token.name === 'streamingchannel') {
      openedAt = token.end
      openDepth = depth
    }
    depth += 1
  }
  return out
}

/**
 * The CHANNEL's own `<enabled>` in a `/ISAPI/Streaming/channels/{id}` document
 * (or in one `<StreamingChannel>` block). `null` when the firmware emits no
 * channel-level flag — distinct from `false`, which means the operator (or the
 * camera) switched the channel off and no picture will come out of it.
 *
 * Never returns `<Video><enabled>` or `<Audio><enabled>`.
 */
export function readStreamingChannelEnabled(xml: string): boolean | null {
  const inner = extractElementInner(xml, 'StreamingChannel') ?? xml
  const raw = readDirectChildText(inner, 'enabled')
  if (raw === null || raw === '') return null
  return raw.trim().toLowerCase() === 'true'
}

/**
 * Parse `/ISAPI/Streaming/channels` into one summary per channel. Element-scoped
 * throughout: `enabled` is the channel's own flag even on a firmware that emits
 * `<Video>` before it.
 */
export function parseStreamingChannelSummaries(xml: string): readonly StreamingChannelSummary[] {
  const out: StreamingChannelSummary[] = []
  for (const block of streamingChannelBlocks(xml)) {
    const channelId = readDirectChildText(block, 'id')
    if (channelId === null || channelId === '') continue
    const name = readDirectChildText(block, 'channelName')
    const enabledRaw = readDirectChildText(block, 'enabled')
    out.push({
      channelId,
      channelName: name === null || name === '' ? null : name,
      // Absent channel-level flag → treat as enabled. A firmware that does not
      // advertise the switch has no switched-off channels to hide.
      enabled:
        enabledRaw === null || enabledRaw === '' ? true : enabledRaw.toLowerCase() === 'true',
    })
  }
  return out
}

/**
 * Build the operator-facing select options from PROBED channels — never a
 * hardcoded main/sub pair. A channel the camera reports as disabled is still
 * listed (choosing it is a legitimate way to say "use this once I re-enable
 * it") but says so, so an operator does not pick a source that cannot produce
 * a picture without being told.
 *
 * Ordered by channel id so main/sub/third read in the natural order.
 */
export function buildSnapshotChannelOptions(
  channels: readonly SnapshotChannelDescriptor[],
): readonly SnapshotChannelOption[] {
  return channels
    .toSorted((a, b) => a.channelId.localeCompare(b.channelId, 'en'))
    .map((c) => {
      const parts: string[] = [`${streamSlotLabel(c.channelId)} — ${c.channelId}`]
      const detail: string[] = []
      if (c.channelName !== null && c.channelName !== undefined && c.channelName !== '') {
        detail.push(c.channelName)
      }
      if (
        c.width !== null &&
        c.width !== undefined &&
        c.height !== null &&
        c.height !== undefined
      ) {
        detail.push(`${c.width}×${c.height}`)
      }
      if (c.codec !== null && c.codec !== undefined && c.codec !== '') detail.push(c.codec)
      if (c.enabled === false) detail.push('disabled on camera')
      if (detail.length > 0) parts.push(`(${detail.join(', ')})`)
      return { value: c.channelId, label: parts.join(' ') }
    })
}

/**
 * Resolve the channel a snapshot is taken from.
 *
 * - Nothing stored → the historical default. This is the whole
 *   no-behaviour-change-on-upgrade guarantee: the setting starts at the channel
 *   the provider already used and only an explicit operator save moves it.
 * - Stored choice present in `available` → the operator's channel.
 * - `available` EMPTY → honour the stored choice. An empty list means the probe
 *   never ran (fresh boot, unreachable camera), not that the camera refused the
 *   channel; discarding an operator's setting because we have not looked yet
 *   would be destroying their work on a fallible read.
 * - Stored choice absent from a non-empty `available` → default, flagged
 *   `fallback-unknown` so the caller can log it.
 */
export function resolveSnapshotChannelId(
  configured: string | null | undefined,
  available: readonly string[],
  fallbackChannelId: string,
): SnapshotChannelResolution {
  const choice = (configured ?? '').trim()
  if (choice === '') return { channelId: fallbackChannelId, source: 'default' }
  if (available.length === 0) return { channelId: choice, source: 'operator' }
  if (available.includes(choice)) return { channelId: choice, source: 'operator' }
  return { channelId: fallbackChannelId, source: 'fallback-unknown' }
}
