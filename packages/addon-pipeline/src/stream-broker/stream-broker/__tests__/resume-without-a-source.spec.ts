/**
 * A resume that cannot resolve a source is not a no-op — it is a dead stream.
 *
 * `checkDemand`'s resume branch read:
 *
 *   if (this._suspended) {
 *     const fresh = this.resolveCurrentSource()
 *     if (fresh) { … resume … }
 *   }
 *
 * with no `else`. `resolveCurrentSource` answers null whenever the cam-stream
 * registry has no entry for the pair — a catalog reconcile, a publisher
 * respawn window — so a broker could sit suspended FOREVER with a live session
 * attached, having decided nothing, having logged nothing. From outside it is
 * indistinguishable from a camera that is simply quiet, which is precisely the
 * shape of the complaint that sent us looking: a stream that stops and only
 * comes back when the viewer forces a new session by hand.
 *
 * The house rule is explicit — a branch that ACCEPTS work and produces nothing
 * is the same as a branch that drops it, and it logs. This pins that, and that
 * the retry is bounded: a camera that genuinely has no published source must
 * not spin.
 */
import { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StreamBroker } from '../stream-broker.js'
import { RtspSession } from '../../rtsp/rtsp-session.js'
import type { IScopedLogger } from '@camstack/types'

const BROKER_ID = '592/native:slot-3'

interface Logged {
  readonly level: 'warn' | 'error' | 'info'
  readonly message: string
  readonly meta: Record<string, unknown>
}

function makeLogger(sink: Logged[]): IScopedLogger {
  const push =
    (level: Logged['level']) =>
    (message: string, opts?: { meta?: Record<string, unknown> }): void => {
      sink.push({ level, message, meta: opts?.meta ?? {} })
    }
  const logger = {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}

/**
 * Put the broker in the state this is about: suspended, never dialled.
 *
 * Reached through the private rather than by driving a real suspend, and
 * deliberately so — the alternative is a dial against a fake URL and a
 * five-second grace timer, which would test the dial path instead of the one
 * branch under test. Same escape hatch the sibling specs use for private state.
 */
function suspend(broker: StreamBroker): void {
  ;(broker as unknown as { _suspended: boolean; _status: string })._suspended = true
}

/** A session that holds LIVE intent — the thing that makes demand real. */
function attachLiveSession(broker: StreamBroker): RtspSession {
  const session = new RtspSession(new Socket(), '', undefined, true, {
    intent: null,
    preRollRequestMs: 0,
  })
  broker.getRtspRestreamer().addSession(session)
  return session
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a suspended broker asked to resume with no resolvable source', () => {
  it('says so, naming the broker, instead of staying dark in silence', async () => {
    vi.useFakeTimers()
    const logs: Logged[] = []
    const broker = new StreamBroker(BROKER_ID, makeLogger(logs))
    // The registry has no entry for this pair — the publisher window, the
    // reconcile gap. This is what production answers, not a thrown error.
    broker.setSourceProvider(() => null)

    // Demand arrives on a broker that is suspended and has never dialled.
    suspend(broker)
    attachLiveSession(broker)
    await vi.advanceTimersByTimeAsync(0)

    const refusal = logs.find((l) => /no source/i.test(l.message))
    expect(
      refusal,
      `expected a line about the missing source, got: ${logs.map((l) => l.message).join(' | ')}`,
    ).toBeDefined()
    expect(refusal?.level).not.toBe('info')
    expect(String(refusal?.meta['brokerId'] ?? '')).toBe(BROKER_ID)
    broker.stop()
  })

  it('retries under a BOUND and then stops — a camera with no source must not spin', async () => {
    vi.useFakeTimers()
    const logs: Logged[] = []
    const resolve = vi.fn(() => null)
    const broker = new StreamBroker(BROKER_ID, makeLogger(logs))
    broker.setSourceProvider(resolve)
    suspend(broker)
    attachLiveSession(broker)

    await vi.advanceTimersByTimeAsync(60_000)
    const attempts = resolve.mock.calls.length
    expect(attempts).toBeGreaterThan(1)
    expect(attempts).toBeLessThanOrEqual(8)

    // And it says it gave up, once — so the log carries the end of the episode
    // as well as its start.
    expect(logs.filter((l) => /giving up|no source/i.test(l.message)).length).toBeLessThanOrEqual(8)
    broker.stop()
  })

  it('resumes normally the moment a source does resolve', async () => {
    vi.useFakeTimers()
    const logs: Logged[] = []
    let published: string | null = null
    const broker = new StreamBroker(BROKER_ID, makeLogger(logs))
    broker.setSourceProvider(() =>
      published === null ? null : { type: 'rfc4571', url: published, videoCodec: 'h264' },
    )
    suspend(broker)
    attachLiveSession(broker)
    await vi.advanceTimersByTimeAsync(1_000)

    published = 'tcp://127.0.0.1:39305'
    await vi.advanceTimersByTimeAsync(10_000)

    expect(logs.some((l) => /resuming stream/i.test(l.message))).toBe(true)
    broker.stop()
  })
})
