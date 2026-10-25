import { type ChildProcess, spawn } from 'node:child_process'
import type { IScopedLogger } from '@camstack/types'

/**
 * One embedded-Python subprocess speaking the length-prefixed frame protocol
 * (`[4B LE len][payload]`, ready = `[0x01]`) — the lifecycle both embedding
 * engines share, written once.
 *
 * ## What it guarantees (D649 review)
 *
 * - **Every awaited frame settles.** Waiters are a FIFO queue (the process
 *   answers in order). On ANY exit — a crash, an OOM kill, a clean 0, the
 *   SIGTERM of `dispose` (code null) — and on a stdin error, every waiter is
 *   rejected. The old guard (`code !== 0 && code !== null`) hung the encode.
 * - **A dead process is dead, by name.** After an unexpected exit the engine
 *   is marked dead with the exit code/signal, the exit is logged, and every
 *   later request rejects immediately with that reason instead of writing to
 *   a closed pipe and waiting forever. Holders check {@link isAlive} and
 *   rebuild — so a crash costs one failed request, not a silent stop.
 * - **EPIPE never escapes.** stdin carries an `error` listener: a write into a
 *   process that just died becomes a rejected request, never an uncaught
 *   exception in the addon.
 */
export class FramedPythonProcess {
  private process: ChildProcess | null = null
  private receiveBuffer: Buffer = Buffer.alloc(0)
  private readonly pending: Array<{
    readonly resolve: (value: Buffer) => void
    readonly reject: (reason: Error) => void
  }> = []
  private dead: string | null = null
  private disposing = false

  constructor(
    /** Error-message prefix, e.g. `PythonTextEncoderEngine`. */
    private readonly name: string,
    private readonly pythonPath: string,
    private readonly args: readonly string[],
    private readonly log: IScopedLogger,
  ) {}

  /** Spawn and wait for the ready frame. */
  async start(): Promise<void> {
    const proc = spawn(this.pythonPath, [...this.args], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.process = proc

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.log.warn(text)
    })
    proc.on('error', (err) => {
      this.log.error(`${this.name}: process error`, { meta: { error: err.message } })
      this.markDead(`process error: ${err.message}`)
    })
    // A write into a process that has just died raises EPIPE on stdin. Without
    // this listener it is an UNCAUGHT exception in the whole addon.
    proc.stdin?.on('error', (err) => {
      this.markDead(`stdin error: ${err.message}`)
    })
    proc.on('exit', (code, signal) => {
      if (this.process === proc) this.process = null
      const reason = `process exited (code ${String(code)}, signal ${String(signal)})`
      if (!this.disposing) {
        this.log.warn(`${this.name}: process exited unexpectedly — the engine is dead`, {
          meta: { code, signal, pid: proc.pid ?? null },
        })
      }
      this.markDead(reason)
    })
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk])
      this.tryReceive()
    })

    const ready = await this.receiveFrame()
    if (ready.length !== 1 || ready[0] !== 0x01) {
      throw new Error(`${this.name}: unexpected ready frame`)
    }
  }

  /** False once the process died or was disposed — a holder must rebuild. */
  isAlive(): boolean {
    return this.process !== null && this.dead === null
  }

  getPid(): number | null {
    return this.process?.pid ?? null
  }

  /** Send one request frame and await its answer. Rejects AT ONCE when dead. */
  async request(payload: Buffer): Promise<Buffer> {
    if (this.dead !== null) {
      throw new Error(`${this.name}: engine is dead — ${this.dead}`)
    }
    const stdin = this.process?.stdin
    if (!stdin) {
      throw new Error(`${this.name}: not initialized — call initialize() first`)
    }
    const answer = this.receiveFrame()
    const len = Buffer.allocUnsafe(4)
    len.writeUInt32LE(payload.length, 0)
    stdin.write(Buffer.concat([len, payload]))
    return answer
  }

  async dispose(): Promise<void> {
    const proc = this.process
    this.disposing = true
    this.markDead('disposed')
    if (!proc) return
    this.process = null
    proc.stdin?.end()
    proc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already dead */
        }
        resolve()
      }, 5_000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private markDead(reason: string): void {
    if (this.dead === null) this.dead = reason
    const err = new Error(`${this.name}: ${reason}`)
    for (const waiter of this.pending.splice(0)) waiter.reject(err)
  }

  private receiveFrame(): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.pending.push({ resolve, reject })
    })
  }

  private tryReceive(): void {
    // Several frames may arrive in one chunk: drain them all, in order.
    while (this.receiveBuffer.length >= 4) {
      const length = this.receiveBuffer.readUInt32LE(0)
      if (this.receiveBuffer.length < 4 + length) return
      const payload = Buffer.from(this.receiveBuffer.subarray(4, 4 + length))
      this.receiveBuffer = this.receiveBuffer.subarray(4 + length)
      this.pending.shift()?.resolve(payload)
    }
  }
}
