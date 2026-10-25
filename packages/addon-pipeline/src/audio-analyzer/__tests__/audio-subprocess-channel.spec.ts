/**
 * D660 round 1 — a request waiting on an audio backend is settled on EVERY way
 * the process can end. Both backends used to reject only on a non-zero exit
 * CODE; a signal exit (`code === null`: dispose's SIGTERM, the memory
 * watchdog, an engine swap, an OOM-kill) left the request hanging, and with
 * one queue for every camera that stopped classification node-wide.
 *
 * These drive a REAL child process (`node -e`), because the defect was in how
 * a real exit is reported.
 */
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import {
  AudioBackendExitedError,
  AudioSubprocessChannel,
  parseClassifyReply,
} from '../audio-subprocess-channel.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

/** A backend that reads requests and never answers — a hung inference. */
const SILENT_BACKEND = "process.stdin.on('data', () => {}); setInterval(() => {}, 1000)"

/** A hung backend that also IGNORES SIGTERM — only SIGKILL ends it. */
const STUBBORN_BACKEND =
  "process.on('SIGTERM', () => {}); process.stdin.on('data', () => {}); setInterval(() => {}, 1000)"

/** A backend that answers every request with one fixed frame. */
function echoBackend(reply: string): string {
  return `const r = Buffer.from(${JSON.stringify(reply)});
process.stdin.on('data', () => {
  const h = Buffer.alloc(4); h.writeUInt32LE(r.length, 0);
  process.stdout.write(Buffer.concat([h, r]));
});`
}

const channels: AudioSubprocessChannel[] = []
function open(script: string): { channel: AudioSubprocessChannel; kill: () => void } {
  const proc = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
  const channel = new AudioSubprocessChannel('Test backend', makeLogger())
  channel.attach(proc)
  channels.push(channel)
  return { channel, kill: () => proc.kill('SIGTERM') }
}

afterEach(async () => {
  await Promise.all(channels.splice(0).map((c) => c.dispose()))
})

describe('AudioSubprocessChannel — a waiting request always settles (D660)', () => {
  it('rejects the waiting request when the backend is killed by a SIGNAL mid-inference', async () => {
    const { channel, kill } = open(SILENT_BACKEND)
    const settled = expect(channel.request(Buffer.alloc(16))).rejects.toBeInstanceOf(
      AudioBackendExitedError,
    )
    kill()
    await settled
    expect(channel.alive).toBe(false)
  })

  it('rejects the waiting request when the channel is disposed mid-inference', async () => {
    const { channel } = open(SILENT_BACKEND)
    const settled = expect(channel.request(Buffer.alloc(16))).rejects.toThrow(/disposed/)
    await channel.dispose()
    await settled
  })

  it('rejects the waiting request at once on dispose, even if the backend ignores SIGTERM', async () => {
    const { channel } = open(STUBBORN_BACKEND)
    // Give the child time to install its SIGTERM handler.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const startedAt = Date.now()
    const settled = expect(channel.request(Buffer.alloc(16))).rejects.toThrow(/disposed/)
    const disposing = channel.dispose()
    await settled
    // Settled before the 5 s SIGKILL grace — the caller is not held by it.
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    await disposing
  }, 15_000)

  it('answers a request with the reply frame', async () => {
    const { channel } = open(
      echoBackend('{"classifications":[{"className":"Dog","score":0.9}],"inferenceMs":4}'),
    )
    const reply = await channel.request(Buffer.alloc(16))
    expect(parseClassifyReply('Test backend', reply)).toEqual({
      classifications: [{ className: 'Dog', score: 0.9 }],
      inferenceMs: 4,
    })
  })
})

describe('parseClassifyReply', () => {
  it('throws on a reply that carries an inference error — never reads it as silence', () => {
    expect(() =>
      parseClassifyReply('YAMNet Python', {
        classifications: [],
        inferenceMs: 3,
        error: 'bad shape',
      }),
    ).toThrow(/inference failed: bad shape/)
  })
})
