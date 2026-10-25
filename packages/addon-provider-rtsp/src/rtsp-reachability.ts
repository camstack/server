import net from 'node:net'

/**
 * Control-plane reachability probe for a generic RTSP camera.
 *
 * Unlike Hikvision/Amcrest/ONVIF, an RTSP source exposes NO management API —
 * we only have an `rtsp://` URL. Reachability is therefore probed at the RTSP
 * control channel itself:
 *
 *   1. open a TCP connection to the RTSP `host:port` (default 554);
 *   2. best-effort send an RTSP `OPTIONS` request;
 *   3. treat an `RTSP/…` response OR a successful TCP handshake (even without
 *      a response before the deadline) as REACHABLE.
 *
 * A successful TCP handshake already proves the camera's RTSP port is live —
 * the `OPTIONS` round-trip is a stronger confirmation when the server answers
 * promptly, but we deliberately fall back to the bare connect so a camera that
 * gates `OPTIONS` behind auth (or is simply slow to answer) is not wrongly
 * marked offline.
 *
 * The socket is always destroyed; the probe never throws and resolves within
 * `timeoutMs`.
 */
const DEFAULT_RTSP_PORT = 554

interface RtspTarget {
  readonly host: string
  readonly port: number
}

/** Parse `host` + `port` out of an `rtsp://` URL. Credentials/path ignored. */
export function parseRtspTarget(url: string): RtspTarget | null {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname) return null
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : DEFAULT_RTSP_PORT
    if (!Number.isFinite(port) || port <= 0 || port > 65_535) return null
    return { host: parsed.hostname, port }
  } catch {
    return null
  }
}

export async function probeRtspReachable(url: string, timeoutMs: number): Promise<boolean> {
  const target = parseRtspTarget(url)
  if (!target) return false

  return new Promise<boolean>((resolve) => {
    let settled = false
    let connected = false
    const socket = new net.Socket()

    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reachable)
    }

    socket.setTimeout(timeoutMs)
    socket.once('timeout', () => finish(connected))
    socket.once('error', () => finish(false))
    socket.once('connect', () => {
      connected = true
      // Best-effort RTSP OPTIONS — a response upgrades our confidence, but
      // the TCP connect alone already proves reachability.
      const request = `OPTIONS ${url} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: camstack-reachability\r\n\r\n`
      socket.write(request, () => {
        /* ignore write errors — the connect already answered the question */
      })
    })
    socket.once('data', (buf: Buffer) => {
      finish(buf.toString('latin1').startsWith('RTSP/') || connected)
    })

    socket.connect(target.port, target.host)
  })
}
