/**
 * Did the source REFUSE this ffmpeg's dial at the RTSP handshake?
 *
 * ffmpeg's rtsp demuxer prints `method <METHOD> failed: <status> <reason>`
 * when the server answers a request with a non-2xx status. On a handshake
 * method (OPTIONS / DESCRIBE / SETUP / PLAY) that means the generation never
 * received a single packet: the url is not being served right now — the
 * restream path is unpublished (404), disabled (403) or has no SDP yet (503) — which is a different
 * fact from a stream that ran and ended (D685). A keepalive failing mid-run
 * (`GET_PARAMETER`) is deliberately NOT a refusal: that stream did run.
 */

/** The request ffmpeg sent and the status the source answered it with. */
export interface DialRefusal {
  readonly method: HandshakeMethod
  readonly status: number
}

type HandshakeMethod = 'OPTIONS' | 'DESCRIBE' | 'SETUP' | 'PLAY'

const METHOD_FAILED = /\bmethod ([A-Z_]+) failed: (\d{3})\b/

function isHandshakeMethod(method: string): method is HandshakeMethod {
  return method === 'OPTIONS' || method === 'DESCRIBE' || method === 'SETUP' || method === 'PLAY'
}

/**
 * ffmpeg's account of a restream that answered DESCRIBE `200` with no SDP at
 * all (a hub that predates the 503 refusal): it opens the url and finds nothing
 * to parse — `Error opening input file rtsp://… ` + `Invalid data found when
 * processing input`, exit 183 (AVERROR_INVALIDDATA & 0xff). Same fact as a
 * refused DESCRIBE: the source is not serving right now, nothing ran.
 */
const OPEN_FAILED = /Error opening input file rtsp:\/\//
const INVALID_DATA = /Invalid data found when processing input/

/** The refusal named in this generation's stderr tail, or `null` when there is none. */
export function readDialRefusal(stderrTail: readonly string[]): DialRefusal | null {
  for (let i = stderrTail.length - 1; i >= 0; i--) {
    const match = METHOD_FAILED.exec(stderrTail[i] ?? '')
    if (match === null) continue
    const method = match[1] ?? ''
    if (!isHandshakeMethod(method)) return null
    return { method, status: Number(match[2]) }
  }
  const text = stderrTail.join('\n')
  if (OPEN_FAILED.test(text) && INVALID_DATA.test(text)) return { method: 'DESCRIBE', status: 503 }
  return null
}
