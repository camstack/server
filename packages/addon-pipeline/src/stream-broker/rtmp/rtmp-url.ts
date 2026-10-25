/**
 * An RTMP url split the way relays and ffmpeg split it: the LAST slash
 * separates the app from the playpath, and a query string BEFORE that slash
 * belongs to the app.
 *
 * `new URL()` was the previous parser and it is not that rule: its query
 * starts at the first `?`, so a LinkVisual relay url
 * (`rtmp://host:8000/live?token=…&session=…&cacheDuration=3000/<stream>`) came
 * out as `app = live` — without the token the relay authenticates on — and
 * `playPath = ?token=…/<stream>`. The relay accepted the connect, answered the
 * play with nothing and closed ("stream ended: readLength end"): the Dreame
 * robot camera, 2026-09-06.
 */
export interface RtmpEndpoint {
  readonly host: string
  readonly port: number
  /** Everything between the host and the last slash — query included. */
  readonly app: string
  /** Everything after the last slash. */
  readonly playPath: string
  /** `rtmp://host:port/app` — what the connect command names. */
  readonly tcUrl: string
}

export const DEFAULT_RTMP_PORT = 1935

const RTMP_URL = /^rtmp:\/\/([^/:]+)(?::(\d+))?\/(.*)$/

export function parseRtmpUrl(url: string): RtmpEndpoint {
  const m = RTMP_URL.exec(url)
  if (!m) throw new Error(`not an rtmp:// url: ${url}`)
  const host = m[1] ?? ''
  const port = m[2] !== undefined ? Number(m[2]) : DEFAULT_RTMP_PORT
  const path = m[3] ?? ''
  const slash = path.lastIndexOf('/')
  if (slash < 0) throw new Error(`rtmp url has no playpath: ${url}`)
  const app = path.slice(0, slash)
  const playPath = path.slice(slash + 1)
  return { host, port, app, playPath, tcUrl: `rtmp://${host}:${String(port)}/${app}` }
}
