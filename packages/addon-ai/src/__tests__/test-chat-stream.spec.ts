/**
 * `runTestChatStream` — the streaming test chat, and the three bounds it owns.
 *
 * ## The bug this replaces
 *
 * The first shape of this feature was an `addons.custom` action that awaited
 * the whole generation. The operator's FIRST real use failed with
 * `UDS request timed out after 60000ms`: `callAddonOnChild` passes no options,
 * so it takes `DEFAULT_UDS_REQUEST_TIMEOUT_MS` and has no per-call override on
 * that path. A cold LM Studio loading qwen3-vl into GPU blows past 60 s
 * routinely, and the error named the transport rather than the model or the
 * endpoint.
 *
 * So the tests below assert the properties that make the replacement honest:
 *
 *   - TOKENS ARRIVE AS THEY ARE PRODUCED, not at the end. Asserted by driving
 *     a provider that emits, pauses, and emits again, and checking what the
 *     client has seen at the pause. This is also the load signal: a first token
 *     is proof the model finished loading.
 *   - THE THREE TIMEOUTS ARE THREE DIFFERENT SENTENCES. connect / first-token /
 *     idle are three faults with three remedies; a shared message cannot say
 *     which one happened.
 *   - ABORT PROPAGATES. The browser closes the response, the provider fetch is
 *     aborted, and no orphan generation keeps a GPU warm.
 *   - EXACTLY ONE USAGE ROW per run, ok or not, mirroring the provider's own
 *     discipline — it is the only durable trace a test call leaves.
 */

import type { LlmProfile } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { TestChatRequest } from '../test-chat/contract.js'
import { type TestChatEvent, TestChatRequestSchema } from '../test-chat/contract.js'
import type { StreamChunk, TestChatStreamDeps } from '../test-chat/run-stream.js'
import { runTestChatStream } from '../test-chat/run-stream.js'
import { createTestLogger, type TestLoggerHandle } from './support/logger.js'
import { makeProfile } from './support/profile.js'

function profile(over: Record<string, unknown> = {}): LlmProfile {
  return makeProfile({
    id: 'p1',
    name: 'Mac LM Studio',
    model: 'qwen/qwen3-vl-8b',
    baseUrl: 'http://192.168.10.50:1234/v1',
    supportsVision: true,
    ...over,
  })
}

function request(over: Partial<TestChatRequest> = {}): TestChatRequest {
  return TestChatRequestSchema.parse({
    profileId: 'p1',
    messages: [{ role: 'user', content: 'ping' }],
    ...over,
  })
}

/** A provider whose chunks the test releases one at a time. */
function manualStream(): {
  readonly iterable: AsyncIterable<StreamChunk>
  push: (chunk: StreamChunk) => void
  close: () => void
} {
  const queue: StreamChunk[] = []
  let notify: (() => void) | null = null
  let closed = false
  const wake = (): void => {
    notify?.()
    notify = null
  }
  return {
    push: (chunk) => {
      queue.push(chunk)
      wake()
    },
    close: () => {
      closed = true
      wake()
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!
          if (closed) return
          await new Promise<void>((r) => (notify = r))
        }
      },
    },
  }
}

interface Harness {
  readonly deps: TestChatStreamDeps
  readonly events: TestChatEvent[]
  readonly logger: TestLoggerHandle
  readonly recordUsage: ReturnType<typeof vi.fn>
  readonly emit: (event: TestChatEvent) => void
}

function harness(over: Partial<TestChatStreamDeps> = {}): Harness {
  const events: TestChatEvent[] = []
  const log = createTestLogger()
  const recordUsage = vi.fn(async () => {})
  const deps: TestChatStreamDeps = {
    getProfile: async () => profile(),
    openStream: async () => ({
      kind: 'open',
      chunks: (async function* () {
        yield { kind: 'token', text: 'hello' } satisfies StreamChunk
        yield {
          kind: 'end',
          inputTokens: 3,
          outputTokens: 1,
          truncated: false,
        } satisfies StreamChunk
      })(),
    }),
    generateOnce: async () => ({
      ok: true,
      text: 'whole answer',
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 2 },
      truncated: false,
      latencyMs: 5,
    }),
    getSnapshot: async () => ({
      base64: Buffer.from('snap').toString('base64'),
      contentType: 'image/jpeg',
    }),
    getTrackMedia: async () => [
      { mediaId: 1344, kind: 'keyFrameSmall', base64: 'AA', sizeBytes: 2, timestamp: 7 },
    ],
    recordUsage,
    logger: log.logger,
    now: () => 1_000,
    ...over,
  }
  return { deps, events, logger: log, recordUsage, emit: (e) => events.push(e) }
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

function kinds(events: readonly TestChatEvent[]): string[] {
  return events.map((e) => e.kind)
}

function text(events: readonly TestChatEvent[]): string {
  return events
    .filter((e): e is Extract<TestChatEvent, { kind: 'token' }> => e.kind === 'token')
    .map((e) => e.text)
    .join('')
}

function errorOf(
  events: readonly TestChatEvent[],
): Extract<TestChatEvent, { kind: 'error' }> | null {
  return (
    events.find((e): e is Extract<TestChatEvent, { kind: 'error' }> => e.kind === 'error') ?? null
  )
}

describe('runTestChatStream — the happy path', () => {
  it('announces what it committed to BEFORE the model answers', async () => {
    const h = harness()
    await runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)
    const meta = h.events.find((e) => e.kind === 'meta')
    expect(meta).toMatchObject({
      profileName: 'Mac LM Studio',
      model: 'qwen/qwen3-vl-8b',
      streamed: true,
      mediaSent: null,
      firstTokenTimeoutMs: 120_000,
    })
    // `meta` precedes every token — the page shows it while the model loads.
    expect(kinds(h.events).indexOf('meta')).toBeLessThan(kinds(h.events).indexOf('token'))
  })

  it('ends with done, carrying the usage the provider reported', async () => {
    const h = harness()
    await runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)
    expect(text(h.events)).toBe('hello')
    expect(h.events.at(-1)).toMatchObject({ kind: 'done', inputTokens: 3, outputTokens: 1 })
  })

  /** THE property that makes this a stream and not a slower unary call. */
  it('emits each token as it is produced, not all of them at the end', async () => {
    const stream = manualStream()
    const h = harness({ openStream: async () => ({ kind: 'open', chunks: stream.iterable }) })
    const run = runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)

    stream.push({ kind: 'token', text: 'a ' })
    await flush()
    // The run has NOT finished, and the client already has the first token.
    expect(text(h.events)).toBe('a ')
    expect(kinds(h.events)).not.toContain('done')

    stream.push({ kind: 'token', text: 'white van' })
    await flush()
    expect(text(h.events)).toBe('a white van')

    stream.push({ kind: 'end', inputTokens: 5, outputTokens: 4, truncated: false })
    stream.close()
    await run
    expect(kinds(h.events)).toContain('done')
  })

  it('walks the phases so a wait reads as progress', async () => {
    const h = harness()
    await runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)
    const phases = h.events
      .filter((e): e is Extract<TestChatEvent, { kind: 'status' }> => e.kind === 'status')
      .map((e) => e.phase)
    expect(phases).toEqual(['connecting', 'first-token-wait', 'streaming'])
  })

  it('writes exactly one usage row — the only durable trace a test call leaves', async () => {
    const h = harness()
    await runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)
    expect(h.recordUsage).toHaveBeenCalledTimes(1)
    expect(h.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ consumer: 'adhoc-ui', profileId: 'p1', ok: true, outputTokens: 1 }),
    )
  })
})

describe('runTestChatStream — the three timeouts are three sentences', () => {
  it('an unreachable endpoint is named as such, quickly', async () => {
    const h = harness({
      openStream: async () => ({ kind: 'connect-timeout', timeoutMs: 10_000 }),
    })
    await runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)
    const err = errorOf(h.events)
    expect(err?.code).toBe('unavailable')
    expect(err?.message).toMatch(/endpoint/i)
    expect(err?.message).toMatch(/10/)
    expect(err?.message).not.toMatch(/UDS/)
    // The remedy is "fix the endpoint", and the log has to say so.
    expect(h.logger.entries.some((e) => /unreachable|endpoint/i.test(e.message))).toBe(true)
  })

  it('a refused connection reports the network reason, not a timeout', async () => {
    const h = harness({
      openStream: async () => ({ kind: 'network', message: 'ECONNREFUSED 192.168.10.50:1234' }),
    })
    await runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)
    expect(errorOf(h.events)?.message).toMatch(/ECONNREFUSED/)
  })

  it('a cold model that never produces a first token says THAT, with the number', async () => {
    vi.useFakeTimers()
    try {
      const stream = manualStream() // opens, then never emits
      const h = harness({ openStream: async () => ({ kind: 'open', chunks: stream.iterable }) })
      const run = runTestChatStream(
        h.deps,
        request({ firstTokenTimeoutMs: 120_000 }),
        h.emit,
        new AbortController().signal,
      )
      await vi.advanceTimersByTimeAsync(119_000)
      expect(errorOf(h.events)).toBeNull()
      await vi.advanceTimersByTimeAsync(2_000)
      stream.close()
      await run

      const err = errorOf(h.events)
      expect(err?.code).toBe('timeout')
      expect(err?.message).toMatch(/120/)
      // The remedy is "warm it or raise the bound" — a different sentence from
      // the unreachable-endpoint one.
      expect(err?.message).toMatch(/no output|first token|loading/i)
      expect(err?.message).not.toMatch(/endpoint did not accept/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stream that stalls MID-answer is an idle timeout, not a cold load', async () => {
    vi.useFakeTimers()
    try {
      const stream = manualStream()
      const h = harness({ openStream: async () => ({ kind: 'open', chunks: stream.iterable }) })
      const run = runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)
      stream.push({ kind: 'token', text: 'half an ans' })
      await vi.advanceTimersByTimeAsync(1)
      // The model proved it was loaded, so the generous first-token bound is
      // over and the shorter idle bound applies.
      await vi.advanceTimersByTimeAsync(61_000)
      stream.close()
      await run

      const err = errorOf(h.events)
      expect(err?.code).toBe('timeout')
      expect(err?.message).toMatch(/stopped|stalled|idle/i)
      // Whatever it managed to say is still on screen.
      expect(text(h.events)).toBe('half an ans')
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * The live regression, at the layer that writes the sentence.
   *
   * A cold LM Studio accepts the socket and then says nothing for minutes
   * while the model loads. The client now reports that as its own outcome, and
   * what MUST NOT come back is the connect sentence: the operator was twice
   * sent to check a running provider and a correct base URL.
   */
  it('an endpoint that accepted and then went silent is a COLD LOAD, never `unavailable`', async () => {
    const h = harness({
      openStream: async (_request, opts) => {
        opts.onConnected()
        return { kind: 'first-token-timeout', timeoutMs: opts.firstTokenTimeoutMs }
      },
    })
    await runTestChatStream(
      h.deps,
      request({ firstTokenTimeoutMs: 120_000 }),
      h.emit,
      new AbortController().signal,
    )

    const err = errorOf(h.events)
    expect(err?.code).toBe('timeout')
    expect(err?.code).not.toBe('unavailable')
    expect(err?.message).toMatch(/120/)
    expect(err?.message).toMatch(/cold load/i)
    expect(err?.message).not.toMatch(/endpoint did not accept/i)
    expect(err?.message).not.toMatch(/base URL/i)
  })

  it('says the model is being waited on BEFORE the endpoint has answered a byte', async () => {
    // The phase line is the whole difference between "loading" and "hung". It
    // has to flip the moment the SOCKET is up — long before `meta`, which on a
    // cold box does not arrive until the model has finished loading.
    const h = harness({
      openStream: async (_request, opts) => {
        opts.onConnected()
        return { kind: 'open', chunks: manualStream().iterable }
      },
    })
    void runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)
    await flush()

    const order = h.events.map((e) => (e.kind === 'status' ? `status:${e.phase}` : e.kind))
    expect(order.indexOf('status:first-token-wait')).toBeGreaterThan(
      order.indexOf('status:connecting'),
    )
    expect(order.indexOf('status:first-token-wait')).toBeLessThan(order.indexOf('meta'))
  })

  it('a provider that REFUSES keeps its own code — auth is not "endpoint down"', async () => {
    const h = harness({
      openStream: async () => ({
        kind: 'provider-error',
        code: 'auth',
        message: 'invalid api key',
      }),
    })
    await runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)

    const err = errorOf(h.events)
    expect(err?.code).toBe('auth')
    expect(err?.message).toBe('invalid api key')
    expect(err?.message).not.toMatch(/could not be reached/i)
    expect(h.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, errorCode: 'auth' }),
    )
  })

  it('the headers and the first token share ONE budget — the page promises one number', async () => {
    vi.useFakeTimers()
    try {
      let clock = 0
      const stream = manualStream() // opens, then never emits
      const h = harness({
        now: () => clock,
        openStream: async (_request, opts) => {
          // 90 s of the 120 s budget spent loading before a byte came back.
          opts.onConnected()
          clock += 90_000
          return { kind: 'open', chunks: stream.iterable }
        },
      })
      const run = runTestChatStream(
        h.deps,
        request({ firstTokenTimeoutMs: 120_000 }),
        h.emit,
        new AbortController().signal,
      )
      // Only 30 s are left, not another 120.
      await vi.advanceTimersByTimeAsync(29_000)
      expect(errorOf(h.events)).toBeNull()
      await vi.advanceTimersByTimeAsync(2_000)
      stream.close()
      await run

      expect(errorOf(h.events)?.code).toBe('timeout')
      // …and the number quoted is still the one the operator was promised.
      expect(errorOf(h.events)?.message).toMatch(/120/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('records a usage row for a failed run too', async () => {
    const h = harness({ openStream: async () => ({ kind: 'connect-timeout', timeoutMs: 10_000 }) })
    await runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)
    expect(h.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, errorCode: 'unavailable' }),
    )
  })
})

describe('runTestChatStream — abort propagates', () => {
  it('stops the run and never emits done when the client goes away', async () => {
    const stream = manualStream()
    const controller = new AbortController()
    const h = harness({ openStream: async () => ({ kind: 'open', chunks: stream.iterable }) })
    const run = runTestChatStream(h.deps, request(), h.emit, controller.signal)
    stream.push({ kind: 'token', text: 'partial' })
    await flush()

    controller.abort()
    stream.close()
    await run

    expect(kinds(h.events)).not.toContain('done')
    expect(h.logger.entries.some((e) => /abort|client/i.test(e.message))).toBe(true)
  })

  /** No orphan generation may keep the GPU warm after the tab is closed. */
  it('hands the signal to the provider call so the socket is torn down', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | null = null
    const h = harness({
      openStream: async (_request, opts) => {
        seen = opts.signal
        return { kind: 'open', chunks: manualStream().iterable }
      },
    })
    void runTestChatStream(h.deps, request(), h.emit, controller.signal)
    await flush()
    expect(seen).toBe(controller.signal)
  })

  it('refuses to start at all when the client already left', async () => {
    const controller = new AbortController()
    controller.abort()
    const openStream = vi.fn()
    const h = harness({ openStream })
    await runTestChatStream(h.deps, request(), h.emit, controller.signal)
    expect(openStream).not.toHaveBeenCalled()
  })
})

describe('runTestChatStream — the cheap question first (D54)', () => {
  it('refuses an unknown or disabled profile before anything else', async () => {
    const h = harness({ getProfile: async () => null })
    await runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)
    expect(errorOf(h.events)?.code).toBe('no-profile')
  })

  it('refuses a vision turn on a text-only profile WITHOUT reading the camera', async () => {
    const getSnapshot = vi.fn()
    const h = harness({ getProfile: async () => profile({ supportsVision: false }), getSnapshot })
    await runTestChatStream(
      h.deps,
      request({ attachment: { kind: 'snapshot', deviceId: 102 } }),
      h.emit,
      new AbortController().signal,
    )
    expect(errorOf(h.events)?.code).toBe('bad-request')
    expect(getSnapshot).not.toHaveBeenCalled()
    expect(h.logger.entries.some((e) => e.extras?.tags?.deviceId === 102)).toBe(true)
  })

  it('reports what it attached, and says it is fetching while it does', async () => {
    const h = harness()
    await runTestChatStream(
      h.deps,
      request({ attachment: { kind: 'track', trackId: 't1', deviceId: 102 } }),
      h.emit,
      new AbortController().signal,
    )
    const phases = h.events
      .filter((e): e is Extract<TestChatEvent, { kind: 'status' }> => e.kind === 'status')
      .map((e) => e.phase)
    expect(phases[0]).toBe('resolving-image')
    expect(h.events.find((e) => e.kind === 'meta')).toMatchObject({
      mediaSent: { kind: 'track', mediaKind: 'keyFrameSmall', capturedAt: 7 },
    })
  })

  it('surfaces an evicted track as a readable error, not as an empty answer', async () => {
    const h = harness({ getTrackMedia: async () => [] })
    await runTestChatStream(
      h.deps,
      request({ attachment: { kind: 'track', trackId: 't-gone', deviceId: 102 } }),
      h.emit,
      new AbortController().signal,
    )
    expect(errorOf(h.events)?.message).toMatch(/best-shot/i)
  })
})

/**
 * Live on the hub, 2026-08-14: a request naming the attachment field
 * `attachment` against a schema that called it `imageRef` was ACCEPTED, the key
 * was stripped by the default object parse, and the model answered the vision
 * question with "specify what you want described" at `inputTokens: 10`. No
 * error, no log. These four tests are that failure, nailed down.
 */
describe('a requested picture is never lost in silence', () => {
  it('rejects an unknown request field instead of stripping it', () => {
    const parsed = TestChatRequestSchema.safeParse({
      profileId: 'p1',
      messages: [{ role: 'user', content: 'what is this?' }],
      // The name a caller actually reached for when the schema said `imageRef`.
      imageRef: { kind: 'snapshot', deviceId: 102 },
    })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/imageRef/)
  })

  it('ends the run with an error when the requested picture cannot be resolved', async () => {
    const h = harness({ getSnapshot: async () => null })
    await runTestChatStream(
      h.deps,
      request({ attachment: { kind: 'snapshot', deviceId: 102 } }),
      h.emit,
      new AbortController().signal,
    )
    expect(errorOf(h.events)?.code).toBe('unavailable')
    // The whole point: NO answer without the picture. Not a token, not a done.
    expect(kinds(h.events)).not.toContain('token')
    expect(kinds(h.events)).not.toContain('done')
    expect(h.logger.entries.some((e) => e.extras?.tags?.deviceId === 102)).toBe(true)
  })

  it('never sends a text-only turn for a request that asked for vision', async () => {
    const openStream = vi.fn()
    const h = harness({ getSnapshot: async () => null, openStream })
    await runTestChatStream(
      h.deps,
      request({ attachment: { kind: 'snapshot', deviceId: 102 } }),
      h.emit,
      new AbortController().signal,
    )
    expect(openStream).not.toHaveBeenCalled()
  })

  it('states mediaSent whenever an attachment was requested and the run went ahead', async () => {
    const h = harness()
    await runTestChatStream(
      h.deps,
      request({ attachment: { kind: 'snapshot', deviceId: 102 } }),
      h.emit,
      new AbortController().signal,
    )
    const meta = h.events.find((e) => e.kind === 'meta')
    expect(meta).toBeDefined()
    expect(meta?.kind === 'meta' && meta.mediaSent).not.toBeNull()
  })

  /**
   * The run "succeeds" and the answer looks like an answer — the only tell is
   * the input count. qwen3-vl bills a picture at hundreds of tokens; the live
   * failure reported ten.
   */
  it('warns when a turn carrying an image is billed like a text-only one', async () => {
    const h = harness({
      openStream: async () => ({
        kind: 'open',
        chunks: (async function* () {
          yield { kind: 'token', text: 'specify what you want described' } satisfies StreamChunk
          yield {
            kind: 'end',
            inputTokens: 10,
            outputTokens: 6,
            truncated: false,
          } satisfies StreamChunk
        })(),
      }),
    })
    await runTestChatStream(
      h.deps,
      request({ attachment: { kind: 'snapshot', deviceId: 102 } }),
      h.emit,
      new AbortController().signal,
    )
    const warn = h.logger.entries.find((e) => /input token|did not reach|billed/i.test(e.message))
    expect(warn?.level).toBe('warn')
    expect(warn?.extras?.tags?.deviceId).toBe(102)
  })

  it('does NOT warn when the provider reported no usage at all', async () => {
    const h = harness({
      openStream: async () => ({
        kind: 'open',
        chunks: (async function* () {
          yield { kind: 'token', text: 'a white van' } satisfies StreamChunk
          // No `include_usage` on the stream → no counts. Zero is "unknown",
          // and must never be read as "ten".
          yield {
            kind: 'end',
            inputTokens: 0,
            outputTokens: 0,
            truncated: false,
          } satisfies StreamChunk
        })(),
      }),
    })
    await runTestChatStream(
      h.deps,
      request({ attachment: { kind: 'snapshot', deviceId: 102 } }),
      h.emit,
      new AbortController().signal,
    )
    expect(h.logger.entries.some((e) => /did not reach|billed/i.test(e.message))).toBe(false)
  })
})

describe('runTestChatStream — profiles whose wire has no token stream', () => {
  it('says streamed:false and delivers the whole answer as one token', async () => {
    const h = harness({
      getProfile: async () => profile({ kind: 'anthropic', baseUrl: undefined }),
      openStream: async () => ({ kind: 'unsupported' }),
    })
    await runTestChatStream(h.deps, request(), h.emit, new AbortController().signal)
    expect(h.events.find((e) => e.kind === 'meta')).toMatchObject({ streamed: false })
    expect(text(h.events)).toBe('whole answer')
    expect(h.events.at(-1)?.kind).toBe('done')
  })

  it('still bounds the non-streaming call by the first-token timeout', async () => {
    vi.useFakeTimers()
    try {
      const h = harness({
        openStream: async () => ({ kind: 'unsupported' }),
        generateOnce: () => new Promise(() => {}),
      })
      const run = runTestChatStream(
        h.deps,
        request({ firstTokenTimeoutMs: 120_000 }),
        h.emit,
        new AbortController().signal,
      )
      await vi.advanceTimersByTimeAsync(121_000)
      await run
      expect(errorOf(h.events)?.code).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})
