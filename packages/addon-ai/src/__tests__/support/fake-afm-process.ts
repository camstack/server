/**
 * A scripted stand-in for the `camstack-afm` child: it records every request
 * line the supervisor writes and lets a test answer, stay silent, write junk
 * or exit — the whole decision tree without a Mac or a model.
 */
import { PassThrough } from 'node:stream'
import { z } from 'zod'
import type { HelperProcess, HelperSpawner } from '../../runtime/apple/afm-helper.js'

const WrittenRequestSchema = z
  .object({ id: z.string(), op: z.string(), target: z.string().optional() })
  .loose()
export type WrittenRequest = z.infer<typeof WrittenRequestSchema>

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void
type ErrorListener = (err: Error) => void

export class FakeAfmProcess implements HelperProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly written: WrittenRequest[] = []
  killed = false
  /** Auto-responder; `undefined` = stay silent. */
  onRequest: ((req: WrittenRequest, proc: FakeAfmProcess) => void) | undefined
  private exitListeners: ExitListener[] = []
  private errorListeners: ErrorListener[] = []

  write(line: string): void {
    const req = WrittenRequestSchema.parse(JSON.parse(line))
    this.written.push(req)
    this.onRequest?.(req, this)
  }
  reply(payload: Readonly<Record<string, unknown>>): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`)
  }
  writeRaw(text: string): void {
    this.stdout.write(text)
  }
  onExit(listener: ExitListener): void {
    this.exitListeners.push(listener)
  }
  onError(listener: ErrorListener): void {
    this.errorListeners.push(listener)
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    for (const l of this.exitListeners) l(code, signal)
  }
  fail(err: Error): void {
    for (const l of this.errorListeners) l(err)
  }
  kill(): void {
    this.killed = true
    this.exit(null, 'SIGTERM')
  }
}

export interface FakeSpawnerHandle {
  readonly spawn: HelperSpawner
  readonly processes: FakeAfmProcess[]
}

/** Every spawn gets a fresh process wired with `configure`. */
export function fakeSpawner(
  configure: (proc: FakeAfmProcess) => void = () => {},
): FakeSpawnerHandle {
  const processes: FakeAfmProcess[] = []
  const spawn: HelperSpawner = () => {
    const proc = new FakeAfmProcess()
    configure(proc)
    processes.push(proc)
    return proc
  }
  return { spawn, processes }
}

/** Let the readline interface deliver what the fake just wrote. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}
