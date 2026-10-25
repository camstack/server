/**
 * Which source types are dialed ONLY when a consumer is attached.
 *
 * The rule this encodes is the user-visible one: **a stream is open only when
 * someone is watching.** Every PULL source — one where CamStack opens a
 * connection TO the camera — belongs here. Ordinary push sources (a camera
 * delivering into us) do not: there is nothing to defer. **Derived** push
 * brokers are the exception — see {@link isDerivedOnDemandSource}: their
 * feeder only runs on demand, so an idle derived must start suspended too.
 *
 * `flv` was missing until 2026-08-07, and it is a pull source: HTTP-FLV dials
 * the camera's own web server. The cost was measured on the live hub against
 * the Reolink "Baby monitor" (deviceId 106, a battery camera asleep ~99.9% of
 * the time): every broker (re)start fired an ffmpeg process at
 * `http://<cam>/flv?...` for BOTH the main and sub slots, which failed 1-3 s
 * later with `Connection refused` / `No route to host` and only THEN logged
 * `Reconnect skipped — no demand, broker suspended`. ~120 such dials a day at
 * one sleeping camera, every one of them for a stream nobody had asked for.
 *
 * Note the shape of that bug: the demand check already governed the RECONNECT
 * path, so the machinery was right and only the FIRST dial escaped it.
 *
 * `http` was missing until 2026-08-12, and it is the same failure class one
 * door along. `pull-http` (MJPEG — the terminal addon's glances relay is the
 * live example) normalises to `type: 'http'` in `buildSourceFromCamStream`,
 * so the guard never fired for it. The cost, measured on the live hub: a
 * PERMANENT `libx264` transcode of a relay with zero viewers (~12% of a core)
 * and the relay's PTY held open for hours. The operator's expectation for a
 * terminal camera is "0 prebuffer, nessun carico di default"; this is half of
 * what makes that true (the other half is not default-warming it — see
 * `StreamBrokerManager.isDefaultWarm`).
 */
export type LazyDialSourceType = 'rtsp' | 'rtmp' | 'rfc4571' | 'flv' | 'http'

const LAZY_DIAL_SOURCE_TYPES: ReadonlySet<string> = new Set<LazyDialSourceType>([
  // Hammering a remote camera with reconnect storms when nobody is watching is
  // useless and bandwidth-expensive.
  'rtsp',
  'rtmp',
  // Keeping the loopback open would keep the lib's upstream Baichuan socket
  // alive (good for reaction time) but violates the rule above. The lib's
  // `ensureRfc4571Server` self-heals if its TCP server idle-tore-down between
  // dials, and the manager's `sourceProvider` re-resolves a fresh URL on every
  // dial — a re-publish after recreate is observed transparently.
  'rfc4571',
  // HTTP-FLV pulls from the camera's web server. On a sleeping battery camera
  // this is a touch that buys nothing; on a mains camera it is an ffmpeg
  // process held open for an audience of nobody.
  'flv',
  // HTTP/MJPEG (`pull-http`) pulls from an HTTP endpoint and is normalised to
  // H.264 by an ffmpeg transcode on the way in — so an unwatched one costs a
  // continuous ENCODE, not just a socket. It is also the cheapest source in
  // the set to re-dial (no camera handshake, no keyframe wait beyond the
  // encoder's first GOP), which makes deferring it strictly a win.
  'http',
])

/**
 * True when a source must not be dialed until {@link StreamBroker.hasDemand}
 * is satisfied.
 */
export function isLazyDialSource(sourceType: string): boolean {
  return LAZY_DIAL_SOURCE_TYPES.has(sourceType)
}

/**
 * True when a push broker is a derived stream whose feeder only runs while
 * consumed (`attachDerivedFeeder` / `DerivedFeederController`).
 *
 * Without this, `start()` latched `status:'streaming'` with `lastPacketAt=0`
 * and the health sweep labelled the idle derived `stale-timeout` — NC then
 * notified stream-offline/online on every restart for the camera's low
 * profile. Lazy-dial pulls already avoid that via `_suspended`; derived must
 * take the same path so the reason is `suspended` / `resumed` (discarded).
 */
export function isDerivedOnDemandSource(source: {
  readonly type: string
  readonly metadata?: Readonly<Record<string, unknown>>
}): boolean {
  return source.type === 'push' && source.metadata?.['kind'] === 'derived'
}

/**
 * True when `start()` must register idle (no dial / no "waiting for push")
 * until live intent arrives — pull lazy-dial OR derived on-demand push.
 */
export function shouldDeferBrokerStart(source: {
  readonly type: string
  readonly metadata?: Readonly<Record<string, unknown>>
}): boolean {
  return isLazyDialSource(source.type) || isDerivedOnDemandSource(source)
}
