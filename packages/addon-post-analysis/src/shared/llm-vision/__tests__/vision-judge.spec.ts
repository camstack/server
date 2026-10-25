/**
 * The judge is asserted on the two things the gates used to each own a copy of:
 * the lenient parse, and what NO ANSWER means.
 *
 * The fail-direction tests are the load-bearing ones. `NcConfirmGate` and
 * `SceneConfirmGate` are now the SAME class with opposite `failDirection`, so a
 * regression that made one of them behave like the other would be invisible in
 * their own suites right up until a real notification was silenced.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { extractJsonObject, parseModelJson } from '../parse-model-json.js'
import { type JudgeVisionResult, LlmVisionJudge, type VisionJudgeDeps } from '../vision-judge.js'

const AnswerSchema = z.object({
  holds: z.boolean(),
  reason: z
    .string()
    .catch('')
    .transform((r) => r.slice(0, 300)),
})

function testLogger(): VisionJudgeDeps['logger'] {
  const noop = (): void => undefined
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => testLogger(),
  } as unknown as VisionJudgeDeps['logger']
}

interface Harness {
  readonly deps: VisionJudgeDeps
  readonly calls: Array<{
    consumer: string
    temperature: number
    bytes: Uint8Array
    imageCount: number
    timeoutMs?: number
  }>
}

function harness(result: JudgeVisionResult | (() => Promise<JudgeVisionResult>)): Harness {
  const calls: Harness['calls'] = []
  const deps: VisionJudgeDeps = {
    logger: testLogger(),
    generateVision: async (request) => {
      calls.push({
        consumer: request.consumer,
        temperature: request.temperature,
        bytes: request.images[0]?.bytes ?? new Uint8Array(),
        imageCount: request.images.length,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      })
      return typeof result === 'function' ? result() : result
    },
    downscale: async (bytes) => bytes,
  }
  return { deps, calls }
}

const IMAGE = {
  bytes: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
  mimeType: 'image/jpeg',
}

function call<T extends z.ZodTypeAny>(schema: T, over: Record<string, unknown> = {}) {
  return {
    deviceId: 102,
    images: [IMAGE],
    system: 'be a judge',
    prompt: 'is the bin there?',
    jsonSchema: { type: 'object' },
    answerSchema: schema,
    maxImagePx: 448,
    timeoutMs: 50,
    logMeta: { monitorId: 'm1' },
    ...over,
  }
}

describe('parseModelJson', () => {
  it('reads a clean object, a fenced one, and one buried in prose', () => {
    const schema = z.object({ holds: z.boolean() })
    expect(parseModelJson('{"holds":true}', schema)).toEqual({ holds: true })
    expect(parseModelJson('```json\n{"holds":false}\n```', schema)).toEqual({
      holds: false,
    })
    expect(parseModelJson('Sure! {"holds":true} Hope that helps.', schema)).toEqual({ holds: true })
  })

  it('returns null — never a guess — when the answer is absent or wrong-shaped', () => {
    const schema = z.object({ holds: z.boolean() })
    expect(parseModelJson('the bin is still there', schema)).toBeNull()
    expect(parseModelJson('{"holds":"yes"}', schema)).toBeNull()
    expect(parseModelJson('{ broken', schema)).toBeNull()
    expect(parseModelJson('', schema)).toBeNull()
  })

  it('takes the OUTERMOST braces, so a nested object survives', () => {
    expect(extractJsonObject('x {"a":{"b":1}} y')).toBe('{"a":{"b":1}}')
    expect(extractJsonObject('no braces here')).toBeNull()
  })
})

describe('LlmVisionJudge — the fail direction', () => {
  const openConfig = {
    consumer: 'notifier-rules',
    failDirection: 'open' as const,
    maxPendingPerDevice: 3,
  }
  const closedConfig = {
    consumer: 'scene-monitor',
    failDirection: 'closed' as const,
    maxPendingPerDevice: 3,
  }

  it('a fail-OPEN judge says proceed on every no-answer path', async () => {
    for (const result of [
      { ok: false, code: 'no-profile' },
      { ok: false, code: 'unavailable', message: 'ECONNREFUSED' },
      { ok: true, text: 'I think so, probably' }, // unparseable
    ]) {
      const { deps } = harness(result)
      const judge = new LlmVisionJudge(deps, openConfig)
      const outcome = await judge.judge(call(AnswerSchema))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.proceed).toBe(true)
    }
  })

  it('a fail-CLOSED judge says do-not-proceed on the very same paths', async () => {
    for (const result of [
      { ok: false, code: 'no-profile' },
      { ok: false, code: 'unavailable', message: 'ECONNREFUSED' },
      { ok: true, text: 'I think so, probably' },
    ]) {
      const { deps } = harness(result)
      const judge = new LlmVisionJudge(deps, closedConfig)
      const outcome = await judge.judge(call(AnswerSchema))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.proceed).toBe(false)
    }
  })

  it('overrideProceed is the operator inverting the default, in both directions', async () => {
    const { deps } = harness({ ok: false, code: 'unavailable' })
    const open = new LlmVisionJudge(deps, openConfig)
    const closed = new LlmVisionJudge(deps, closedConfig)

    const suppressed = await open.judge(call(AnswerSchema, { overrideProceed: false }))
    const flipped = await closed.judge(call(AnswerSchema, { overrideProceed: true }))

    expect(suppressed.ok).toBe(false)
    if (!suppressed.ok) expect(suppressed.proceed).toBe(false)
    expect(flipped.ok).toBe(false)
    if (!flipped.ok) expect(flipped.proceed).toBe(true)
  })

  it('no image is a no-answer that still honours the direction', async () => {
    const { deps, calls } = harness({ ok: true, text: '{"holds":true}' })
    const judge = new LlmVisionJudge(deps, closedConfig)
    const outcome = await judge.judge(call(AnswerSchema, { images: [] }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure).toBe('no-image')
      expect(outcome.proceed).toBe(false)
    }
    // …and the model was never asked.
    expect(calls).toHaveLength(0)
  })

  it('names WHICH failure happened — the remedies differ', async () => {
    const cases: Array<[JudgeVisionResult, string]> = [
      [{ ok: false, code: 'no-profile' }, 'error'],
      [{ ok: true, text: 'nope' }, 'unparseable'],
    ]
    for (const [result, failure] of cases) {
      const { deps } = harness(result)
      const judge = new LlmVisionJudge(deps, openConfig)
      const outcome = await judge.judge(call(AnswerSchema))
      if (!outcome.ok) expect(outcome.failure).toBe(failure)
    }
  })

  it('a `no-profile` code becomes a sentence an operator can act on', async () => {
    const { deps } = harness({ ok: false, code: 'no-profile' })
    const judge = new LlmVisionJudge(deps, closedConfig)
    const outcome = await judge.judge(call(AnswerSchema))
    if (!outcome.ok) expect(outcome.reason).toBe('no vision profile configured')
  })

  it('a cap client that THROWS is a no-answer, not a crash in the delivery path', async () => {
    const deps: VisionJudgeDeps = {
      logger: testLogger(),
      generateVision: async () => {
        throw new Error('transport exploded')
      },
      downscale: async (bytes) => bytes,
    }
    const judge = new LlmVisionJudge(deps, openConfig)
    const outcome = await judge.judge(call(AnswerSchema))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure).toBe('error')
      expect(outcome.proceed).toBe(true)
    }
  })

  it('a slow model times out at the bound and does not hang the caller', async () => {
    const { deps } = harness(
      () => new Promise<JudgeVisionResult>(() => undefined), // never answers
    )
    const judge = new LlmVisionJudge(deps, closedConfig)
    const outcome = await judge.judge(call(AnswerSchema, { timeoutMs: 20 }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failure).toBe('timeout')
      expect(outcome.proceed).toBe(false)
    }
  })
})

describe('LlmVisionJudge — the mechanics both gates used to copy', () => {
  const config = {
    consumer: 'notifier-rules',
    failDirection: 'open' as const,
    maxPendingPerDevice: 3,
  }

  it('a good answer comes back parsed, with the model name and a latency', async () => {
    const { deps } = harness({
      ok: true,
      text: '```{"holds":true,"reason":"bin visible"}```',
      model: 'qwen',
    })
    const judge = new LlmVisionJudge(deps, config)
    const outcome = await judge.judge(call(AnswerSchema))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.value).toEqual({ holds: true, reason: 'bin visible' })
      expect(outcome.model).toBe('qwen')
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('temperature is pinned to 0 per call — a verdict must not vary run to run', async () => {
    const { deps, calls } = harness({ ok: true, text: '{"holds":true}' })
    const judge = new LlmVisionJudge(deps, config)
    await judge.judge(call(AnswerSchema))
    expect(calls[0]?.temperature).toBe(0)
    expect(calls[0]?.consumer).toBe('notifier-rules')
  })

  it('a failed downscale judges the FULL-SIZE image instead of losing the verdict', async () => {
    const calls: Uint8Array[] = []
    const deps: VisionJudgeDeps = {
      logger: testLogger(),
      generateVision: async (request) => {
        calls.push(request.images[0]?.bytes ?? new Uint8Array())
        return { ok: true, text: '{"holds":true}' }
      },
      downscale: async () => {
        throw new Error('sharp missing')
      },
    }
    const judge = new LlmVisionJudge(deps, config)
    const outcome = await judge.judge(call(AnswerSchema))
    expect(outcome.ok).toBe(true)
    expect(calls[0]).toEqual(IMAGE.bytes)
  })

  it('bounds concurrency per device: one in flight, two queued, the rest refused', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps } = harness(async () => {
      await gate
      return { ok: true, text: '{"holds":true}' }
    })
    const judge = new LlmVisionJudge(deps, config)

    const inFlight = judge.judge(call(AnswerSchema))
    const queued1 = judge.judge(call(AnswerSchema))
    const queued2 = judge.judge(call(AnswerSchema))
    // Let the three register before the fourth asks.
    await vi.waitFor(() => undefined)
    const refused = await judge.judge(call(AnswerSchema))

    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.failure).toBe('busy')

    release()
    for (const settled of await Promise.all([inFlight, queued1, queued2])) {
      expect(settled.ok).toBe(true)
    }
  })

  it('carries EVERY image of a joint call, in order, each downscaled', async () => {
    // The digest's whole question is joint: "what happened across these six
    // frames", which cannot be asked one frame at a time. The judge takes a
    // LIST because the count is a parameter of the caller, not of the judge —
    // the two confirm gates simply pass a list of one.
    const seen: Uint8Array[] = []
    const deps: VisionJudgeDeps = {
      logger: testLogger(),
      generateVision: async (request) => {
        for (const image of request.images) seen.push(image.bytes)
        return { ok: true, text: '{"holds":true}' }
      },
      // Marks each image so the ORDER is checkable, not just the count.
      downscale: async (bytes) => new Uint8Array([...bytes, 0xff]) as Uint8Array<ArrayBuffer>,
    }
    const judge = new LlmVisionJudge(deps, config)
    const outcome = await judge.judge(
      call(AnswerSchema, {
        images: [
          {
            bytes: new Uint8Array([1]) as Uint8Array<ArrayBuffer>,
            mimeType: 'image/jpeg',
          },
          {
            bytes: new Uint8Array([2]) as Uint8Array<ArrayBuffer>,
            mimeType: 'image/jpeg',
          },
          {
            bytes: new Uint8Array([3]) as Uint8Array<ArrayBuffer>,
            mimeType: 'image/jpeg',
          },
        ],
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(seen.map((b) => [...b])).toEqual([
      [1, 0xff],
      [2, 0xff],
      [3, 0xff],
    ])
  })

  it('ONE image that will not downscale costs its own bytes, never the whole call', async () => {
    let n = 0
    const deps: VisionJudgeDeps = {
      logger: testLogger(),
      generateVision: async (request) => {
        expect(request.images.map((i) => [...i.bytes])).toEqual([[1, 0xff], [2]])
        return { ok: true, text: '{"holds":true}' }
      },
      downscale: async (bytes) => {
        n += 1
        if (n === 2) throw new Error('sharp missing')
        return new Uint8Array([...bytes, 0xff]) as Uint8Array<ArrayBuffer>
      },
    }
    const judge = new LlmVisionJudge(deps, config)
    const outcome = await judge.judge(
      call(AnswerSchema, {
        images: [
          {
            bytes: new Uint8Array([1]) as Uint8Array<ArrayBuffer>,
            mimeType: 'image/jpeg',
          },
          {
            bytes: new Uint8Array([2]) as Uint8Array<ArrayBuffer>,
            mimeType: 'image/jpeg',
          },
        ],
      }),
    )
    expect(outcome.ok).toBe(true)
  })

  it('a different camera is never blocked by a busy one', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const deps: VisionJudgeDeps = {
      logger: testLogger(),
      generateVision: async () => {
        if (first) {
          first = false
          await gate
        }
        return { ok: true, text: '{"holds":true}' }
      },
      downscale: async (bytes) => bytes,
    }
    const judge = new LlmVisionJudge(deps, config)
    const busy = judge.judge(call(AnswerSchema, { deviceId: 102 }))
    const other = await judge.judge(call(AnswerSchema, { deviceId: 101 }))
    expect(other.ok).toBe(true)
    release()
    expect((await busy).ok).toBe(true)
  })
})

/**
 * The judge's bound has to reach the PROVIDER, not merely start a stopwatch
 * beside it.
 *
 * `call.timeoutMs` was only ever an external race: the judge stopped waiting at
 * its bound while the generation upstream ran on to `profile.timeoutMs` — 60 s
 * by default. A summary that asks for 180 s therefore got 60, and the digest
 * shipped without its sentence. `llm.generateVision` has always accepted a
 * per-call `timeoutMs`; nothing was passing one.
 */
describe('LlmVisionJudge — the bound reaches the provider', () => {
  const config = {
    consumer: 'ai-summary',
    failDirection: 'open' as const,
    maxPendingPerDevice: 3,
  }

  it('forwards its own timeout to the cap call', async () => {
    const { deps, calls } = harness({ ok: true, text: '{"holds":true}' })
    const judge = new LlmVisionJudge(deps, config)
    await judge.judge(call(AnswerSchema, { timeoutMs: 180_000 }))
    expect(calls[0]?.timeoutMs).toBe(180_000)
  })
})
