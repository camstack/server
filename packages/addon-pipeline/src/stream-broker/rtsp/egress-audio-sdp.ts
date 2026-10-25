/**
 * Egress audio SDP grafting.
 *
 * The push-mode restreamer SDP (built by `buildSdp`) is video-only: one
 * `m=video` track on payload 96, `a=control:trackID=0`. To carry transcoded
 * audio we let ffmpeg's RTP muxer emit the authoritative audio SDP (`-sdp_file`,
 * correct fmtp/config even for AAC), extract its `m=audio` block, and graft it
 * onto the video SDP as a second track (`trackID=1`).
 *
 * Two rewrites keep the grafted block consistent with the server SDP:
 *   - the media port is forced to 0 (RTSP uses interleaved TCP, the port is
 *     irrelevant and ffmpeg writes its own UDP port);
 *   - a *dynamic* payload type (>= 96) is remapped to 97 so it never collides
 *     with the video track's 96. Static types (PCMU=0, PCMA=8) are left intact.
 *
 * Pure + side-effect-free so the grafting is unit-testable without ffmpeg.
 */

const VIDEO_PAYLOAD_TYPE = 96
const AUDIO_DYNAMIC_PAYLOAD_TYPE = 97

interface ExtractOptions {
  /** trackID to assign to the grafted audio track. Defaults to 1. */
  readonly trackId?: number
}

/**
 * Extract the `m=audio` media block from an ffmpeg-generated SDP, normalised
 * for grafting (port 0, non-colliding payload type, own `a=control`, explicit
 * connection line). Returns `null` when the SDP has no audio media section.
 */
export function extractAudioMediaBlock(
  ffmpegSdp: string,
  options: ExtractOptions = {},
): string | null {
  const trackId = options.trackId ?? 1
  const lines = ffmpegSdp.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => l.startsWith('m=audio'))
  if (startIdx < 0) return null

  // Collect the audio media block: from `m=audio` to the next `m=` or EOF.
  const block: string[] = []
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!
    if (i > startIdx && line.startsWith('m=')) break
    if (line.trim().length === 0) continue
    if (line.startsWith('a=control:')) continue // we add our own
    block.push(line)
  }

  // Parse the original payload type from `m=audio <port> RTP/AVP <pt>`.
  const mLine = block[0]!
  const mParts = mLine.split(/\s+/)
  const origPt = Number.parseInt(mParts[3] ?? '', 10)
  if (!Number.isInteger(origPt)) return null
  const newPt = origPt >= 96 ? AUDIO_DYNAMIC_PAYLOAD_TYPE : origPt

  const remapped = block.map((line) => {
    if (line.startsWith('m=audio')) {
      return `m=audio 0 ${mParts.slice(2).join(' ').replace(String(origPt), String(newPt))}`
    }
    if (origPt !== newPt && (line.startsWith('a=rtpmap:') || line.startsWith('a=fmtp:'))) {
      return line.replace(`:${origPt} `, `:${newPt} `)
    }
    return line
  })

  // Ensure a connection line so the block is self-contained (ffmpeg puts c= at
  // session level). Insert right after the m= line if absent.
  if (!remapped.some((l) => l.startsWith('c='))) {
    remapped.splice(1, 0, 'c=IN IP4 0.0.0.0')
  }

  remapped.push(`a=control:trackID=${trackId}`)
  return remapped.join('\r\n')
}

/**
 * Append a grafted audio media block to a video-only SDP, preserving CRLF
 * framing and the trailing blank line.
 */
export function appendAudioMediaBlock(videoSdp: string, audioBlock: string): string {
  const trimmed = videoSdp.replace(/[\r\n]+$/, '')
  return `${trimmed}\r\n${audioBlock}\r\n`
}

export { VIDEO_PAYLOAD_TYPE, AUDIO_DYNAMIC_PAYLOAD_TYPE }
