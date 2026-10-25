/**
 * Burst-download the hub's `/adaptive-probe` blob and return Mbps.
 * Used as `hints.downlinkMbps` so adaptive selection is based on a measured
 * path, not viewport size or IP class. Failures return null (caller keeps
 * the default-low / ceiling path and may stay on the lowest rung).
 *
 * D635 (2026-09-25): the probe used to time a 128 KiB blob from the REQUEST,
 * fired in parallel with `createSession` on a hub at ~80 % CPU. It read the
 * LAN as 1.2–1.46 Mbps — the elapsed time was mostly waiting for the first
 * byte, i.e. latency. It now (1) times the body from its FIRST byte, (2) reads
 * a 1 MiB blob so the transfer dominates timer jitter, and (3) runs after the
 * session's first decoded frame, never during session setup.
 */
export const ADAPTIVE_PROBE_PATH = '/adaptive-probe' // hub-path-ok: composed on the resolved hub base (resolveProbeOrigin)
/**
 * Whole-probe deadline, from the request. A probe cut here is still a
 * measurement of whatever body arrived (see {@link measureDownlinkMbps}).
 */
export const ADAPTIVE_PROBE_TIMEOUT_MS = 2500
/**
 * Fewest body bytes AFTER the first chunk that make a rate. 64 KiB: at the
 * `high` threshold (8 Mbps) that is 65 ms of transfer — four times a 16 ms
 * WebView timer tick. Less is a guess, and a guess is unknown, not slow.
 */
export const ADAPTIVE_PROBE_MIN_MEASURED_BYTES: number = 64 * 1024
/** How long the probe waits for the session's first decoded frame. */
export const FIRST_FRAME_PROBE_TIMEOUT_MS = 15_000
/** How often the first-frame wait looks at the video element. */
const FIRST_FRAME_POLL_MS = 250
/** `HTMLMediaElement.HAVE_CURRENT_DATA`: a frame is decoded and presentable. */
const HAVE_CURRENT_DATA = 2

export type AdaptiveTier = 'high' | 'mid' | 'low'

/** Mbps needed to attempt each rung (bitrate / 0.6 headroom, rounded). */
export const DOWNLINK_HIGH_MBPS = 8
export const DOWNLINK_MID_MBPS = 2.5

/** Map a measured downlink onto the adaptive ladder. Mid is a real rung. */
export function suggestedAdaptiveTier(mbps: number): AdaptiveTier {
  if (mbps >= DOWNLINK_HIGH_MBPS) return 'high'
  if (mbps >= DOWNLINK_MID_MBPS) return 'mid'
  return 'low'
}

/** First connect never carries a cached probe — the broker starts lowest. */
export function stripDownlinkForColdStart<T extends { readonly downlinkMbps?: number }>(
  hints: T,
): Omit<T, 'downlinkMbps'> {
  const { downlinkMbps: _ignored, ...rest } = hints
  return rest
}

/** After a probe, only mid/high justify a make-before-break climb. */
export function shouldUpgradeAfterProbe(mbps: number): boolean {
  return suggestedAdaptiveTier(mbps) !== 'low'
}

/**
 * An http(s) base — origin plus any path prefix, no trailing slash — or null
 * for anything that cannot serve the probe. The prefix is kept because a hub
 * reached through a path-mounted relay (`https://<ha>/api/camstack/p/<g>`)
 * serves `/adaptive-probe` UNDER that prefix; the bare origin is the relay.
 */
function httpOrigin(value: string | undefined): string | null {
  if (value === undefined || value === '') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

/**
 * The origin `/adaptive-probe` must be fetched from — the HUB, not the page.
 *
 * The page origin was the original assumption ("same-origin as the player",
 * `adaptive-probe.routes.ts`) and it is only true for the web viewer and the
 * iframe embed, both served by the hub. The NATIVE viewer loads this same
 * player from an asset bundled with the app (`useNativeEmbedSource` resolves
 * `assets/embed/camstack-embed.html` through `Image.resolveAssetSource`), so
 * inside the WKWebView `window.location.origin` is `file://` — and
 * `file:///adaptive-probe` is not a request any hub can answer. The probe
 * therefore returned null on EVERY native connect, `downlinkMbps` was never
 * sent, `pickAdaptiveTier` scored every session `default-low`, and
 * `shouldUpgradeAfterProbe` was never even reached — so the make-before-break
 * climb that the cold-start default depends on could not run. That is the
 * whole of "the automatic quality always drops to low" on the app.
 *
 * The hub the player is already talking to is the `serverUrl` prop, so it
 * wins; the page origin remains as the fallback for a host that passes a
 * relative/empty `serverUrl`. Null means no probe is possible and the caller
 * must skip it rather than fetch a URL that cannot exist.
 */
export function resolveProbeOrigin(
  serverUrl: string | undefined,
  pageOrigin: string | undefined,
): string | null {
  return httpOrigin(serverUrl) ?? httpOrigin(pageOrigin)
}

/** Which offer composed the hints. A climb and a cold start read identically
 *  in the hub's log; only the client knows which one it just sent. */
export type AdaptiveOfferPhase =
  | 'cold-start'
  | 'probe-climb'
  | 'renegotiate'
  | 'probe-refused'
  /** The probe went to the session it was measured on; the hub answered (D733). */
  | 'probe-in-session'

/**
 * What the CLIENT sent for one adaptive decision. Deliberately not the hub's
 * verdict — the hub already logs its own pick, and a client line that repeated
 * it would prove nothing about the client. This is the other half of that
 * join: the inputs the hub scored, plus whether the downlink probe had an
 * origin it could even reach.
 */
export interface AdaptiveHintsReport {
  readonly phase: AdaptiveOfferPhase
  /** Null when no http(s) origin resolved — the probe did not run at all. */
  readonly probeOrigin: string | null
  readonly viewportWidth?: number
  readonly viewportHeight?: number
  readonly devicePixelRatio?: number
  readonly downlinkMbps?: number
  readonly prefersTier?: string
  /** For `probe-refused`: the HTTP status the hub answered the probe with (401/429…). */
  readonly probeStatus?: number
  /** For `probe-in-session`: what the hub did with it — `outcome:tier:reason`. */
  readonly probeAnswer?: string
}

/**
 * Identity of a decision, for "log once per CHANGE, not per tick".
 *
 * `downlinkMbps` is a fresh measurement on every probe and would otherwise
 * make every offer look like a new decision. What the ladder actually consumes
 * is the RUNG it maps to (`suggestedAdaptiveTier`), so two measurements that
 * pick the same rung are the same decision and must collapse to one line.
 */
export function adaptiveHintsKey(report: AdaptiveHintsReport): string {
  const rung =
    report.downlinkMbps === undefined ? 'none' : suggestedAdaptiveTier(report.downlinkMbps)
  return [
    report.phase,
    report.viewportWidth ?? '-',
    report.viewportHeight ?? '-',
    report.devicePixelRatio ?? '-',
    rung,
    report.prefersTier ?? '-',
    report.probeOrigin ?? 'unreachable',
    report.probeStatus ?? '-',
    report.probeAnswer ?? '-',
  ].join('|')
}

/** The slice of a body reader the probe uses (a `ReadableStreamDefaultReader` fits). */
export interface ProbeBodyReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>
  cancel(): Promise<void>
}

/** The slice of a fetch `Response` the probe uses. */
export interface ProbeResponse {
  readonly ok: boolean
  readonly status?: number
  readonly body?: { getReader(): ProbeBodyReader } | null
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface DownlinkProbeDeps {
  readonly fetchImpl: (url: string, init: { signal: AbortSignal }) => Promise<ProbeResponse>
  readonly now: () => number
  /**
   * The hub answered but refused (401 without a session, 429 rate-limited).
   * The reading is still unknown — but a missing token must not be silent,
   * or it is indistinguishable from a failed probe (review N3, D391).
   */
  readonly onRefused?: (status: number) => void
}

function mbpsOf(bytes: number, elapsedMs: number): number | null {
  if (bytes < ADAPTIVE_PROBE_MIN_MEASURED_BYTES || !(elapsedMs > 0)) return null
  return (bytes * 8) / elapsedMs / 1000
}

/**
 * Stream the body and time it from the FIRST chunk to the last one. The first
 * chunk's own bytes are excluded — they arrived at the instant the clock
 * started. A read that fails (the deadline abort) ends the measurement with
 * what DID arrive: a slow link cut at 2.5 s is still a measured slow link.
 */
async function timeStreamedBody(
  reader: ProbeBodyReader,
  now: () => number,
): Promise<number | null> {
  let firstAt: number | null = null
  let lastAt = 0
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      const size = chunk.value?.byteLength ?? 0
      const at = now()
      if (firstAt === null) {
        firstAt = at
      } else {
        bytes += size
      }
      lastAt = at
    }
  } catch {
    // Deadline or network cut: fall through with what arrived.
    void reader.cancel().catch(() => undefined)
  }
  if (firstAt === null) return null
  return mbpsOf(bytes, lastAt - firstAt)
}

export async function measureDownlinkMbps(
  origin: string,
  deps: DownlinkProbeDeps,
): Promise<number | null> {
  const base = origin.replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ADAPTIVE_PROBE_TIMEOUT_MS)
  try {
    const res = await deps.fetchImpl(`${base}${ADAPTIVE_PROBE_PATH}`, { signal: ctrl.signal })
    if (!res.ok) {
      if (res.status !== undefined) deps.onRefused?.(res.status)
      return null
    }
    const reader = res.body?.getReader() ?? null
    if (reader !== null) return await timeStreamedBody(reader, deps.now)
    // No streamed body: time from the response (headers received) — still
    // after time-to-first-byte, never from the request.
    const headersAt = deps.now()
    const buf = await res.arrayBuffer()
    return mbpsOf(buf.byteLength, deps.now() - headersAt)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export type FirstFrameOutcome = 'frame' | 'timeout' | 'aborted'

export interface FirstFrameDeps {
  /** The live video element's `readyState`, or null when there is none yet. */
  readonly readyState: () => number | null
  readonly signal: AbortSignal
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
}

/**
 * Resolve once the session presents its first decoded frame — the moment
 * session setup (createSession, ICE, DTLS, the first IDR) is over and a probe
 * no longer competes with it for the hub or the link.
 */
export async function waitForFirstFrame(
  deps: FirstFrameDeps,
  timeoutMs: number = FIRST_FRAME_PROBE_TIMEOUT_MS,
): Promise<FirstFrameOutcome> {
  const deadline = deps.now() + timeoutMs
  for (;;) {
    if (deps.signal.aborted) return 'aborted'
    if ((deps.readyState() ?? 0) >= HAVE_CURRENT_DATA) return 'frame'
    if (deps.now() >= deadline) return 'timeout'
    await deps.sleep(FIRST_FRAME_POLL_MS)
  }
}

/**
 * The cold-start probe: measure only once the first frame is up. No frame ⇒
 * no measurement (undefined) — the session is failing for a reason a probe
 * cannot fix, and a climb would only add a second connection to it.
 */
export interface ProbeAfterFirstFrameDeps {
  readonly waitFrame: () => Promise<FirstFrameOutcome>
  readonly measure: () => Promise<number | undefined>
}

export async function probeAfterFirstFrame(
  deps: ProbeAfterFirstFrameDeps,
): Promise<number | undefined> {
  const outcome = await deps.waitFrame()
  if (outcome !== 'frame') return undefined
  return deps.measure()
}

/** The latest probe for an origin, whatever it read or how old it is. */
export interface LatestProbe {
  readonly mbps: number
  readonly ageMs: number
}

export interface DownlinkProbeStoreDeps {
  readonly now: () => number
  /** How long a reading answers `measured`/`cached` without re-probing. */
  readonly ttlMs: number
}

export interface DownlinkProbeStore {
  /**
   * The cached reading while fresh, else ONE probe for the origin — concurrent
   * callers share the probe in flight (review I6: a grid decoding together
   * fired N 1 MiB probes, each reading the link ÷ N). Undefined = unknown.
   */
  measured(origin: string, measure: () => Promise<number | null>): Promise<number | undefined>
  /** The cached reading while fresh — never probes (review I5: renegotiation). */
  cached(origin: string): number | undefined
  /** The newest reading whatever its age — what the telemetry reports (I4). */
  latest(origin: string): LatestProbe | null
  /** True the FIRST time `origin` refuses with `status` in this app — say it once. */
  firstRefusal(origin: string, status: number): boolean
}

/** App-wide probe cache + single-flight, one per origin. */
export function createDownlinkProbe(deps: DownlinkProbeStoreDeps): DownlinkProbeStore {
  const readings = new Map<string, { readonly mbps: number; readonly at: number }>()
  const inFlight = new Map<string, Promise<number | undefined>>()
  const refusals = new Set<string>()
  const cached = (origin: string): number | undefined => {
    const r = readings.get(origin)
    return r !== undefined && deps.now() - r.at <= deps.ttlMs ? r.mbps : undefined
  }
  return {
    cached,
    firstRefusal: (origin, status) => {
      const key = `${origin}|${String(status)}`
      if (refusals.has(key)) return false
      refusals.add(key)
      return true
    },
    latest: (origin) => {
      const r = readings.get(origin)
      return r === undefined ? null : { mbps: r.mbps, ageMs: Math.max(0, deps.now() - r.at) }
    },
    measured: (origin, measure) => {
      const hit = cached(origin)
      if (hit !== undefined) return Promise.resolve(hit)
      const running = inFlight.get(origin)
      if (running !== undefined) return running
      const probe = measure()
        .then((mbps) => {
          if (mbps === null || !Number.isFinite(mbps)) return undefined
          readings.set(origin, { mbps, at: deps.now() })
          return mbps
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight.delete(origin)
        })
      inFlight.set(origin, probe)
      return probe
    },
  }
}

/** The hub's answer to one session's probe — `webrtcSession.applyDownlinkProbe` (D733). */
export interface DownlinkProbeAnswer {
  readonly outcome: 'switching' | 'held'
  readonly tier: string | null
  readonly reason: string
}

/** Host wiring for `webrtcSession.applyDownlinkProbe`, bound to the device. */
export type ApplyDownlinkProbe = (
  sessionId: string,
  downlinkMbps: number,
) => Promise<DownlinkProbeAnswer>

/** What became of handing a probe to its session. */
export type ProbeHandoff =
  | { readonly kind: 'answered'; readonly answer: DownlinkProbeAnswer }
  | { readonly kind: 'unsupported'; readonly why: 'no-wiring' | 'no-session' | 'call-failed' }

/**
 * Hand a probe to the session it was measured on (D733).
 *
 * The probe climb used to be a SECOND session: a make-before-break reconnect
 * carrying `downlinkMbps`, so every adaptive live open cost two sessions. The
 * hub now moves the open session to the probed rung itself. `answered` means
 * the hub owns the climb, WHATEVER it answered — `held` included: a reconnect
 * after a `held` would buy the second session for a rung the hub just refused.
 * Only `unsupported` (no host wiring, no session id yet, or a hub that does not
 * know the method) leaves the caller its legacy reconnect climb.
 */
export async function handProbeToSession(
  apply: ApplyDownlinkProbe | undefined,
  sessionId: string | null,
  downlinkMbps: number,
): Promise<ProbeHandoff> {
  if (apply === undefined) return { kind: 'unsupported', why: 'no-wiring' }
  if (sessionId === null) return { kind: 'unsupported', why: 'no-session' }
  try {
    return { kind: 'answered', answer: await apply(sessionId, downlinkMbps) }
  } catch {
    return { kind: 'unsupported', why: 'call-failed' }
  }
}
