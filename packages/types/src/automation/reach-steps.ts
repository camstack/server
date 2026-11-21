/**
 * The runtime of the `probe` and `http-request` steps: one measurement, an
 * expectation judged on it, and an optional retry window.
 *
 * Nothing here touches the network. The generated block injects `connect`
 * (`node:net`) and `fetch`, so a spec runs the whole loop on fakes and this
 * file stays loadable in the browser bundle of `@camstack/types`.
 *
 * A measurement that FAILED is `null`, never `0` (D393): an unreachable host
 * has `rttMs: null`, a request that never got an answer has `status: null`.
 * Nothing returned here carries a header value or a request body — the step's
 * message and the run trace are built from these outcomes.
 */
import type { AutomationHttpExpect } from './recipe.js'
import { HTTP_TEXT_CAP, REACH_RETRY_INTERVAL_S, REACH_RETRY_MAX_S } from './recipe.js'
import { compareValues } from './hold.js'

export interface ReachProbeResult {
  readonly reachable: boolean
  readonly rttMs: number | null
  readonly error: string | null
}

export interface HttpResult {
  readonly status: number | null
  readonly ok: boolean
  readonly json: unknown
  readonly text: string | null
  readonly error: string | null
}

/** Open a TCP connection and close it: resolves when the port answered, rejects with the reason. */
export type TcpConnect = (host: string, port: number, timeoutMs: number) => Promise<void>

/** What a `fetch` answers, as far as this step reads it. */
export interface HttpResponseLike {
  readonly status: number
  text(): Promise<string>
}

export interface HttpRequestInit {
  readonly method: string
  readonly headers?: Record<string, string>
  readonly body?: string
  readonly signal: AbortSignal
}

export type HttpFetch = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>

/** The clock and the run, injected: a window is judged on `now`, a pause is `sleep`. */
export interface ReachClock {
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly isAborted: () => boolean
}

export interface ReachOutcome<R> {
  readonly result: R
  /** Whether the expectation held on the LAST attempt. */
  readonly met: boolean
  readonly attempts: number
  /** One line for the trace: the attempt count and what the last attempt saw. No header, no body. */
  readonly message: string
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── the retry loop ──────────────────────────────────────────────────────────

interface RetryInput<R> {
  readonly attempt: () => Promise<R>
  readonly met: (result: R) => boolean
  readonly windowSeconds: number | undefined
}

/**
 * Try, and while the expectation does not hold and the window is open, pause
 * {@link REACH_RETRY_INTERVAL_S} s and try again. Bounded twice: the window is
 * clamped to {@link REACH_RETRY_MAX_S}, and the pause is a constant.
 */
async function retryUntilMet<R>(
  clock: ReachClock,
  input: RetryInput<R>,
): Promise<{ result: R; met: boolean; attempts: number }> {
  const windowMs = Math.min(input.windowSeconds ?? 0, REACH_RETRY_MAX_S) * 1000
  const deadline = clock.now() + windowMs
  const interval = REACH_RETRY_INTERVAL_S * 1000
  let attempts = 0
  for (;;) {
    const result = await input.attempt()
    attempts += 1
    const met = input.met(result)
    if (met || clock.isAborted()) return { result, met, attempts }
    const left = deadline - clock.now()
    if (left <= 0) return { result, met, attempts }
    await clock.sleep(Math.min(interval, left))
    if (clock.isAborted()) return { result, met, attempts }
  }
}

// ── probe ───────────────────────────────────────────────────────────────────

export interface ProbeInput {
  readonly host: string
  readonly port: number
  readonly timeoutSeconds: number
  readonly expect?: 'reachable' | 'unreachable'
  readonly retryUntilSeconds?: number
}

export interface ProbeDeps extends ReachClock {
  readonly connect: TcpConnect
}

async function probeOnce(deps: ProbeDeps, input: ProbeInput): Promise<ReachProbeResult> {
  const startedAt = deps.now()
  try {
    await deps.connect(input.host, input.port, input.timeoutSeconds * 1000)
    return { reachable: true, rttMs: Math.max(0, deps.now() - startedAt), error: null }
  } catch (err: unknown) {
    return { reachable: false, rttMs: null, error: errorText(err) }
  }
}

export async function runProbeStep(
  deps: ProbeDeps,
  input: ProbeInput,
): Promise<ReachOutcome<ReachProbeResult>> {
  const want = input.expect ?? 'reachable'
  const run = await retryUntilMet(deps, {
    attempt: () => probeOnce(deps, input),
    met: (result) => result.reachable === (want === 'reachable'),
    windowSeconds: input.retryUntilSeconds,
  })
  const seen = run.result.reachable
    ? `reachable in ${String(run.result.rttMs)} ms`
    : `unreachable (${run.result.error ?? 'no answer'})`
  return {
    ...run,
    message: `${run.met ? 'expected' : 'wanted'} ${want}; after ${String(run.attempts)} attempt(s) ${seen}`,
  }
}

// ── http ────────────────────────────────────────────────────────────────────

export interface HttpInput {
  readonly method: string
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly timeoutSeconds: number
  readonly expect?: AutomationHttpExpect
  readonly retryUntilSeconds?: number
}

export interface HttpDeps extends ReachClock {
  readonly fetch: HttpFetch
}

function parseJson(text: string, truncated: boolean): unknown {
  if (truncated) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return null
  }
}

async function httpOnce(deps: HttpDeps, input: HttpInput): Promise<HttpResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000)
  try {
    const response = await deps.fetch(input.url, {
      method: input.method,
      ...(input.headers === undefined ? {} : { headers: { ...input.headers } }),
      ...(input.body === undefined ? {} : { body: input.body }),
      signal: controller.signal,
    })
    const full = await response.text()
    const truncated = full.length > HTTP_TEXT_CAP
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      json: parseJson(full, truncated),
      text: truncated ? full.slice(0, HTTP_TEXT_CAP) : full,
      error: null,
    }
  } catch (err: unknown) {
    const aborted = controller.signal.aborted
    return {
      status: null,
      ok: false,
      json: null,
      text: null,
      error: aborted ? `timed out after ${String(input.timeoutSeconds)} s` : errorText(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** The value at a dotted path of a parsed body; `undefined` when any step of the path is missing. */
function readPath(root: unknown, path: string): unknown {
  let at: unknown = root
  for (const key of path.split('.')) {
    if (at === null || typeof at !== 'object') return undefined
    at = Reflect.get(at, key)
  }
  return at
}

/**
 * Whether the answer is what the step wanted. No expectation: a 2xx. A field
 * that is not there is never "met" — not even for `ne` — because "absent" is
 * not an answer the operator compared against (D49).
 */
export function httpExpectationMet(
  result: HttpResult,
  expect: AutomationHttpExpect | undefined,
): boolean {
  if (result.status === null) return false
  if (expect === undefined) return result.ok
  if (expect.on === 'status') return compareValues(result.status, expect.operator, expect.value)
  if (expect.fieldPath === undefined) return false
  const actual = readPath(result.json, expect.fieldPath)
  if (actual === undefined) return false
  return compareValues(actual, expect.operator, expect.value)
}

export async function runHttpStep(
  deps: HttpDeps,
  input: HttpInput,
): Promise<ReachOutcome<HttpResult>> {
  const run = await retryUntilMet(deps, {
    attempt: () => httpOnce(deps, input),
    met: (result) => httpExpectationMet(result, input.expect),
    windowSeconds: input.retryUntilSeconds,
  })
  const seen =
    run.result.status === null
      ? `no answer (${run.result.error ?? 'unknown'})`
      : `status ${String(run.result.status)}`
  return {
    ...run,
    message: `${run.met ? 'expectation met' : 'expectation not met'}; after ${String(run.attempts)} attempt(s) ${seen}`,
  }
}

// ── the run variable ────────────────────────────────────────────────────────

const FLAT_DEPTH_MAX = 4
const FLAT_KEYS_MAX = 60

function flatten(
  prefix: string,
  value: unknown,
  depth: number,
  out: Record<string, unknown>,
): void {
  if (Object.keys(out).length >= FLAT_KEYS_MAX) return
  if (value === null || value === undefined) {
    out[prefix] = ''
  } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out[prefix] = value
  } else if (typeof value === 'object' && !Array.isArray(value) && depth < FLAT_DEPTH_MAX) {
    for (const [key, inner] of Object.entries(value))
      flatten(`${prefix}.${key}`, inner, depth + 1, out)
  }
}

/**
 * What a step writes into the run's bag under `saveAs`: the result itself, and
 * its scalar fields flat (`ccu.reachable`, `r.json.sysInfo.addr`), because a
 * `{{vars.x.y}}` slot reads the flat key. A `null` reads as empty text there.
 */
export function reachVars(
  name: string,
  result: ReachProbeResult | HttpResult,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(result)) {
    if (key === 'text') continue
    flatten(`${name}.${key}`, value, 0, flat)
  }
  return { [name]: result, ...flat }
}
