/**
 * Rewrite the host of an `rtsp://host:port/path` URL in place, preserving the
 * port, path, and any trailing segments (e.g. `/token/muted`).
 *
 * The stream-broker is hub-only and mints restream URLs against `127.0.0.1`
 * (only dialable from the hub itself). When a REMOTE consumer asks for a
 * cluster-resolvable host (the `hostname` param of `getStreamWithCodec`), we
 * swap only the host component so the same restreamer (bound on 0.0.0.0,
 * reachable on every interface) can be dialed from another node. The port and
 * token are never touched — they identify the stream, not the route to it.
 *
 * Uses the WHATWG `URL` parser (which handles the non-special `rtsp:` scheme)
 * and falls back to returning the original URL untouched if it can't be parsed
 * or the host is empty — a bad rewrite must never silently corrupt a working
 * hub-local URL.
 */
export function substituteRtspHost(url: string, host: string | undefined): string {
  if (host === undefined || host.length === 0) return url
  try {
    const parsed = new URL(url)
    parsed.hostname = host
    return parsed.toString()
  } catch {
    return url
  }
}
