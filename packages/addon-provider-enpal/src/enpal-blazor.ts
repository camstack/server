import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { EnpalConnection } from './config.js'
import { normalizeEnpalUnit } from './enpal-units.js'
import type { EnpalFallbackReason, EnpalReading, EnpalText } from './enpal-snapshot.js'

/**
 * Firmware 8.51 and later render the device tables of the box's web page only through a
 * Blazor Server circuit, so the HTML of `/deviceMessages` has no device rows. The Python
 * bridge (`python/enpal_worker.py`, built on the Home Assistant component's Blazor protocol
 * modules) opens that circuit the way the page does, reads the sensor rows of the renders the
 * box sends, and prints them as JSON. It is read-only and needs no credential.
 */

/** One row of the box's device tables, as the bridge read it: text, not yet a number. */
export const BlazorRowSchema = z.object({
  key: z.string(),
  value: z.string(),
  unit: z.string().nullable(),
  timestamp: z.string().nullable(),
})
export type BlazorRow = z.infer<typeof BlazorRowSchema>

export const BlazorRowsSchema = z.array(BlazorRowSchema)

const BridgeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), rows: BlazorRowsSchema }),
  z.object({
    ok: z.literal(false),
    kind: z.enum(['unreachable', 'bad-response', 'empty', 'protocol']),
    error: z.string(),
  }),
])

export type BlazorBridgeErrorKind =
  | 'unreachable'
  | 'bad-response'
  | 'empty'
  | 'protocol'
  | 'timeout'

/** A failed bridge run. The message never carries the bridge's stderr beyond a short tail. */
export class BlazorBridgeError extends Error {
  readonly kind: BlazorBridgeErrorKind

  constructor(kind: BlazorBridgeErrorKind, message: string) {
    super(message)
    this.name = 'BlazorBridgeError'
    this.kind = kind
  }
}

export interface BlazorTarget {
  readonly host: string
  readonly port: number
}

/** Reads the device rows of one box. The addon wires the Python bridge; a test hands in a fake. */
export type BlazorReader = (target: BlazorTarget) => Promise<readonly BlazorRow[]>

export interface BlazorBridgeDeps {
  /** The interpreter, from the platform's embedded Python (`ctx.deps.ensurePython()`). */
  readonly pythonPath: string
  /** Absolute path of `python/enpal_worker.py`. */
  readonly scriptPath: string
  readonly timeoutMs?: number
}

/** The worker waits up to 12 s for the box's first render; this leaves room for connect and exit. */
const DEFAULT_TIMEOUT_MS = 40_000
const WINDOW_MS = 12_000
const STDERR_TAIL = 300
/** A real answer is ~25 KB; anything near this is a runaway bridge, not a box. */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024
/** Only the tail of stderr is ever shown, so only a bounded tail is kept. */
const MAX_STDERR_BYTES = 16 * 1024

/**
 * How long `auto` leaves the Blazor channel alone after it failed. An older box that never
 * serves it would otherwise cost the full read window on every poll.
 */
export const BLAZOR_BACKOFF_MS = 10 * 60_000

/** The slowest a good read takes: connect, the 12 s render window, exit. */
export const BLAZOR_WORST_CASE_READ_MS = 20_000

/**
 * The poll interval actually used. A box-web-channel read can take most of
 * {@link BLAZOR_WORST_CASE_READ_MS}, so a shorter interval is raised to it when that channel
 * can be the source: ticks would only pile onto the running read.
 */
export function effectivePollIntervalMs(connection: EnpalConnection): number {
  const usesBlazor = connection.source === 'auto' || connection.source === 'blazor'
  return usesBlazor
    ? Math.max(connection.pollIntervalMs, BLAZOR_WORST_CASE_READ_MS)
    : connection.pollIntervalMs
}

/** Remembers a failed Blazor read so `auto` skips it for a while. Forced `blazor` ignores it. */
export class BlazorBackoff {
  #until = 0
  #reason: EnpalFallbackReason | null = null

  /** Why the channel is being skipped now, or null when it may be tried. */
  skipReason(now: number): EnpalFallbackReason | null {
    if (this.#reason === null || now >= this.#until) return null
    return {
      kind: this.#reason.kind,
      message: `${this.#reason.message}; the box web channel is skipped for ${BLAZOR_BACKOFF_MS / 60_000} minutes after a failure`,
    }
  }

  failed(now: number, reason: EnpalFallbackReason): void {
    this.#until = now + BLAZOR_BACKOFF_MS
    this.#reason = reason
  }

  recovered(): void {
    this.#until = 0
    this.#reason = null
  }
}

/** One bridge run per poll: spawn, write the request on stdin, parse one JSON answer. */
export function createBlazorReader(deps: BlazorBridgeDeps): BlazorReader {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return (target) =>
    new Promise<readonly BlazorRow[]>((resolve, reject) => {
      const child = spawn(deps.pythonPath, [deps.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        action()
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(() =>
          reject(
            new BlazorBridgeError(
              'timeout',
              `Enpal box ${target.host} did not answer within ${timeoutMs / 1000}s`,
            ),
          ),
        )
      }, timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (stdout.length > MAX_STDOUT_BYTES) {
          child.kill('SIGKILL')
          finish(() =>
            reject(
              new BlazorBridgeError(
                'protocol',
                'the Enpal bridge wrote more output than any box answer',
              ),
            ),
          )
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES)
      })
      child.on('error', (err) => {
        finish(() =>
          reject(
            new BlazorBridgeError('protocol', `cannot start the Enpal bridge: ${err.message}`),
          ),
        )
      })
      child.on('close', (code) => {
        finish(() => {
          let json: unknown
          try {
            json = JSON.parse(stdout.trim())
          } catch {
            const tail = stderr.trim().slice(-STDERR_TAIL) || 'no stderr'
            reject(
              new BlazorBridgeError(
                'protocol',
                `the Enpal bridge produced no JSON (exit ${code ?? 'null'}): ${tail}`,
              ),
            )
            return
          }
          const parsed = BridgeResultSchema.safeParse(json)
          if (!parsed.success) {
            reject(new BlazorBridgeError('protocol', 'the Enpal bridge answered an unknown shape'))
            return
          }
          if (!parsed.data.ok) {
            reject(new BlazorBridgeError(parsed.data.kind, parsed.data.error))
            return
          }
          resolve(parsed.data.rows)
        })
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(
        JSON.stringify({
          host: target.host,
          port: target.port,
          windowMs: WINDOW_MS,
        }),
      )
    })
}

const KEY_SHAPE = /^[A-Z][A-Za-z0-9]*(\.[A-Za-z0-9-]+)+$/
/** A bare decimal number: `3.6`, `-40`, `0`. A version, a hash or a timestamp is not one. */
const NUMBER = /^-?\d+(?:[.,]\d+)?$/

/**
 * The numeric sensors of the bridge's rows. A text value (a state name, a serial number, the
 * inverter's markup bitfield) is not a reading, and neither is a dotted string that only
 * looks like a key (`V1.1.7`, a version).
 */
export function blazorRowsToReadings(rows: readonly BlazorRow[]): EnpalReading[] {
  const readings: EnpalReading[] = []
  for (const row of rows) {
    if (!KEY_SHAPE.test(row.key)) continue
    const text = row.value.trim()
    if (!NUMBER.test(text)) continue
    const value = Number(text.replace(',', '.'))
    if (!Number.isFinite(value)) continue
    readings.push({
      key: row.key,
      value,
      unit: normalizeEnpalUnit(row.unit ?? undefined),
      measurement: undefined,
    })
  }
  return readings
}

/**
 * Every row's text as delivered, for state labels, serial numbers and firmware strings. A
 * row with no value, or whose value is markup (the inverter's `<ul>` bitfield), carries no
 * text worth showing and is left out.
 */
export function blazorRowsToTexts(rows: readonly BlazorRow[]): EnpalText[] {
  const texts: EnpalText[] = []
  for (const row of rows) {
    if (!KEY_SHAPE.test(row.key)) continue
    const value = row.value.trim()
    if (value.length === 0 || value.startsWith('<')) continue
    texts.push({ key: row.key, value })
  }
  return texts
}
