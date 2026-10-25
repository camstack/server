/**
 * `AudioSubprocessChannel` — the length-prefixed request/reply wire both audio
 * backends speak (YAMNet's `yamnet_audio.py`, Apple SoundAnalysis's Swift CLI):
 * `[4B LE length][payload]` each way, one request outstanding at a time.
 *
 * ## Why it is one class (D660)
 *
 * The two backends carried a copy each of the same reply slot, and both copies
 * rejected a waiting request only on a NON-ZERO exit code. A child killed by a
 * signal exits with `code === null` — which is exactly what `dispose()` (SIGTERM),
 * the memory watchdog's restart, an engine swap and a kernel OOM-kill produce.
 * The waiting request then never settled, and since D660 every camera's windows
 * wait behind that one request in the analyzer's queue: the whole node stopped
 * classifying until the runner respawned. Here a request is settled on EVERY
 * way the process can end — any exit, a spawn error, and `dispose()` itself.
 */
import type { ChildProcess } from 'node:child_process'
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'

/** The backend process ended (or was disposed) while — or before — a request waited on it. */
export class AudioBackendExitedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AudioBackendExitedError'
  }
}

/** One decoded reply frame. */
export type AudioBackendReply = Readonly<Record<string, unknown>>

interface PendingReply {
  readonly resolve: (reply: AudioBackendReply) => void
  readonly reject: (err: Error) => void
}

/** How long `dispose()` waits for a graceful exit before SIGKILL. */
const DISPOSE_GRACE_MS = 5_000

function isReplyObject(value: unknown): value is AudioBackendReply {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class AudioSubprocessChannel {
  private process: ChildProcess | null = null
  private receiveBuffer: Buffer = Buffer.alloc(0)
  private pending: PendingReply | null = null

  constructor(
    /** Names the backend in every error and line (`YAMNet Python`, `Apple SoundAnalysis`). */
    private readonly label: string,
    private readonly log: IScopedLogger,
  ) {}

  /** Wire a freshly spawned process. Stderr stays the caller's (each backend formats it). */
  attach(proc: ChildProcess): void {
    this.process = proc
    proc.on('error', (err) => {
      this.log.error(`${this.label} process error`, { meta: { error: err.message } })
      this.failPending(new AudioBackendExitedError(`${this.label}: process error: ${err.message}`))
    })
    proc.on('exit', (code, signal) => {
      // ANY exit ends every request waiting on this process — a signal exit
      // has `code === null` and is the common case (dispose, watchdog, OOM).
      if (this.process === proc) this.process = null
      const clean = code === 0 && signal === null
      const meta = { code, signal }
      if (clean) this.log.info(`${this.label} process exited`, { meta })
      else this.log.error(`${this.label} process exited`, { meta })
      this.failPending(
        new AudioBackendExitedError(
          `${this.label}: process exited (code ${String(code)}, signal ${String(signal)})`,
        ),
      )
    })
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk])
      this.tryReceive()
    })
  }

  get pid(): number | null {
    return this.process?.pid ?? null
  }

  get alive(): boolean {
    return this.process !== null
  }

  /** Wait for the next reply frame without sending (the init handshake). */
  receive(): Promise<AudioBackendReply> {
    if (this.process === null) {
      return Promise.reject(new AudioBackendExitedError(`${this.label}: process not running`))
    }
    return new Promise<AudioBackendReply>((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }

  /** Send one payload frame and wait for its reply. */
  request(payload: Buffer): Promise<AudioBackendReply> {
    const stdin = this.process?.stdin
    if (!stdin) {
      return Promise.reject(new AudioBackendExitedError(`${this.label}: process not initialized`))
    }
    const reply = this.receive()
    const lengthBuf = Buffer.allocUnsafe(4)
    lengthBuf.writeUInt32LE(payload.length, 0)
    stdin.write(Buffer.concat([lengthBuf, payload]))
    return reply
  }

  /**
   * Stop the process. The waiting request (if any) is rejected FIRST — the
   * exit event would do it too, but a process that ignores SIGTERM for five
   * seconds must not hold the caller for five seconds.
   */
  async dispose(): Promise<void> {
    this.failPending(new AudioBackendExitedError(`${this.label}: disposed`))
    const proc = this.process
    if (!proc) return
    this.process = null
    proc.stdin?.end()
    proc.kill('SIGTERM')
    const exited = await new Promise<boolean>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve(true)
        return
      }
      const timer = setTimeout(() => resolve(false), DISPOSE_GRACE_MS)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited) {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already dead */
      }
      this.log.warn(`${this.label} process did not exit gracefully — sent SIGKILL`)
    }
  }

  private failPending(err: Error): void {
    const pending = this.pending
    this.pending = null
    pending?.reject(err)
  }

  private tryReceive(): void {
    while (this.receiveBuffer.length >= 4) {
      const length = this.receiveBuffer.readUInt32LE(0)
      if (this.receiveBuffer.length < 4 + length) return
      const bytes = this.receiveBuffer.subarray(4, 4 + length)
      this.receiveBuffer = this.receiveBuffer.subarray(4 + length)
      const pending = this.pending
      this.pending = null
      if (!pending) {
        this.log.warn(`${this.label}: reply with no request waiting — discarded`, {
          meta: { bytes: length },
        })
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(bytes.toString('utf8'))
      } catch (err: unknown) {
        pending.reject(new Error(`${this.label}: unparseable reply: ${errMsg(err)}`))
        continue
      }
      if (isReplyObject(parsed)) pending.resolve(parsed)
      else pending.reject(new Error(`${this.label}: reply is not an object`))
    }
  }
}

/** One label as a backend reports it. */
export interface AudioBackendLabel {
  readonly className: string
  readonly score: number
}

function isBackendLabel(value: unknown): value is AudioBackendLabel {
  if (typeof value !== 'object' || value === null) return false
  const className: unknown = Reflect.get(value, 'className')
  const score: unknown = Reflect.get(value, 'score')
  return typeof className === 'string' && typeof score === 'number'
}

/**
 * Read a classify reply. A reply carrying `error` is a FAILED inference and
 * throws (D660): `yamnet_audio.py` answers an exception with an empty label
 * list plus `error`, and reading that as "no labels" is the silence-vs-nobody-
 * listened confusion D660 removed.
 */
export function parseClassifyReply(
  label: string,
  reply: AudioBackendReply,
): { readonly classifications: readonly AudioBackendLabel[]; readonly inferenceMs: number } {
  const error = reply['error']
  if (typeof error === 'string' && error.length > 0) {
    throw new Error(`${label}: inference failed: ${error}`)
  }
  const raw = reply['classifications']
  const classifications = Array.isArray(raw) ? raw.filter(isBackendLabel) : []
  const ms = reply['inferenceMs']
  return { classifications, inferenceMs: typeof ms === 'number' ? ms : 0 }
}
