/**
 * The camera's microphone, as it appears in a `/ISAPI/Streaming/channels/{id}`
 * document: `<Audio><enabled>`.
 *
 * Two functions, both pure, both here rather than inline in the ISAPI client
 * for one reason — **the document contains more than one `<enabled>`**, and
 * the first one is the whole streaming channel's on/off switch:
 *
 * ```xml
 * <StreamingChannel>
 *   <id>101</id>
 *   <enabled>true</enabled>          <!-- the CHANNEL. Touch this and the -->
 *   <Video>…</Video>                 <!--   camera stops streaming.       -->
 *   <Audio><enabled>true</enabled></Audio>
 * </StreamingChannel>
 * ```
 *
 * The generic tag helper in the client matches the first `<enabled>`. An
 * operator muting a microphone must not take the video stream down, so both
 * the read and the write anchor on the `<Audio>` element and are tested
 * against a document that has both.
 */

/** One streaming channel's microphone state, as read back off the camera. */
export interface StreamAudioChannel {
  readonly channelId: string
  readonly audioEnabled: boolean
}

/** What a microphone write actually achieved, per channel. */
export interface AudioWriteOutcome {
  /** Channels that now hold the requested value. */
  readonly accepted: readonly string[]
  /**
   * Channels that took the call and did not move. A firmware that answers
   * `200 OK` and ignores the body is the whole reason this function exists —
   * measured on Reolink 592's `thirdStream` (2026-08-07), and a Hikvision
   * channel that 500s mid-write produces the same shape.
   */
  readonly refused: readonly string[]
}

/**
 * Compare a post-write read-back against what was asked for.
 *
 * Pure, and separate from the provider, because the DECISION it feeds is the
 * expensive one: `refused` non-empty means put the accepted channels back and
 * fail, rather than leave the camera half-muted while telling the operator it
 * is silent ([D74](../../../docs/decisions/adr-0074.md)).
 *
 * A channel present in `asked` but missing from `after` counts as REFUSED — it
 * stopped answering, so we cannot claim it took the change.
 */
export function classifyAudioWrite(
  asked: readonly string[],
  after: readonly StreamAudioChannel[],
  enabled: boolean,
): AudioWriteOutcome {
  const byId = new Map(after.map((c) => [c.channelId, c.audioEnabled]))
  const accepted: string[] = []
  const refused: string[] = []
  for (const channelId of asked) {
    if (byId.get(channelId) === enabled) accepted.push(channelId)
    else refused.push(channelId)
  }
  return { accepted, refused }
}

/** Locate the `<Audio>…</Audio>` block; `null` when the document has none. */
function extractAudioBlock(xml: string): string | null {
  const match = /<Audio\b[^>]*>([\s\S]*?)<\/Audio>/i.exec(xml)
  return match ? (match[1] ?? '') : null
}

/**
 * Current `<Audio><enabled>` for one streaming channel.
 *
 * `null` = the document has no `<Audio>` block (or no `<enabled>` inside it),
 * i.e. this channel has no controllable audio input. Distinct from `false`,
 * which means the camera has one and it is switched off — only the second
 * justifies offering an operator a microphone switch.
 */
export function readStreamAudioEnabled(xml: string): boolean | null {
  const block = extractAudioBlock(xml)
  if (block === null) return null
  const inner = /<enabled\b[^>]*>([\s\S]*?)<\/enabled>/i.exec(block)
  if (!inner) return null
  return (inner[1] ?? '').trim().toLowerCase() === 'true'
}

/**
 * Read-modify-write `<Audio><enabled>` in a streaming-channel document.
 *
 * Returns the document UNCHANGED when there is no `<Audio><enabled>` to
 * patch — a caller that PUT that back would be writing the camera's own
 * config to itself, which is inert. The caller checks support first
 * (`readStreamAudioEnabled !== null`) and refuses rather than relying on this.
 */
export function patchStreamAudioEnabled(xml: string, enabled: boolean): string {
  const value = enabled ? 'true' : 'false'
  return xml.replace(
    /(<Audio\b[^>]*>[\s\S]*?<enabled\b[^>]*>)[\s\S]*?(<\/enabled>[\s\S]*?<\/Audio>)/i,
    `$1${value}$2`,
  )
}
