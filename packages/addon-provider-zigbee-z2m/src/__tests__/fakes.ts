import type { IScopedLogger } from '@camstack/types'
import type { Z2mSocket, Z2mSocketFactory, Z2mSocketHandlers, Z2mTimers } from '../z2m-client.js'

export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: unknown
}

export function recordingLogger(lines: LogLine[] = []): IScopedLogger {
  const at =
    (level: LogLine['level']) =>
    (message: string, extras?: unknown): void => {
      lines.push({ level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** One fake socket: records what was sent, and lets a test play the server. */
export class FakeSocket implements Z2mSocket {
  readonly sent: string[] = []
  closed = false
  constructor(
    readonly url: string,
    readonly handlers: Z2mSocketHandlers,
  ) {}
  send(text: string): void {
    this.sent.push(text)
  }
  close(): void {
    this.closed = true
  }
  /** The server accepts the connection. */
  open(): void {
    this.handlers.open()
  }
  /** The server pushes a frame. */
  push(topic: string, payload: unknown): void {
    this.handlers.message(JSON.stringify({ topic, payload }))
  }
  pushRaw(text: string): void {
    this.handlers.message(text)
  }
  drop(code = 1006, reason = ''): void {
    this.handlers.close(code, reason)
  }
  sentEnvelopes(): Array<{ topic: string; payload: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s))
  }
}

export class FakeNet {
  readonly sockets: FakeSocket[] = []
  readonly factory: Z2mSocketFactory = (url, handlers) => {
    const socket = new FakeSocket(url, handlers)
    this.sockets.push(socket)
    return socket
  }
  get last(): FakeSocket {
    const socket = this.sockets[this.sockets.length - 1]
    if (socket === undefined) throw new Error('no socket was opened')
    return socket
  }
}

/** Timers a test fires by hand: `fire()` runs the earliest one and reports the delay it had. */
export class ManualTimers implements Z2mTimers {
  readonly scheduled: Array<{ run: () => void; ms: number; live: boolean }> = []
  after(run: () => void, ms: number): () => void {
    const entry = { run, ms, live: true }
    this.scheduled.push(entry)
    return () => {
      entry.live = false
    }
  }
  pending(): number[] {
    return this.scheduled.filter((t) => t.live).map((t) => t.ms)
  }
  fire(): number {
    const entry = this.scheduled.find((t) => t.live)
    if (entry === undefined) throw new Error('no timer is pending')
    entry.live = false
    entry.run()
    return entry.ms
  }
}
