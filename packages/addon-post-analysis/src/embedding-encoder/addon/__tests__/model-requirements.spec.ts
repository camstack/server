/**
 * The requirements gate (D649 round 5): a failed download is not a crash, but
 * it is not "retry on every request" either.
 *
 * - a failed attempt starts a cooldown, doubling to a cap, consulted ON DEMAND
 *   by `check()` — a request inside it is refused at once and nothing is built;
 * - a PERMANENT failure (marked by the one place that can tell) goes terminal
 *   after the bounded attempts; a transient one never does;
 * - success clears everything; reset clears the terminal state and the cooldown;
 * - one log line per transition, never per request.
 */
import {
  EMBEDDING_REQUIREMENTS_FAILED,
  EMBEDDING_REQUIREMENTS_UNAVAILABLE,
  embeddingRefusalOf,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_REQUIREMENTS_ATTEMPTS,
  PermanentRequirementsFailure,
  REQUIREMENTS_COOLDOWN_BASE_MS,
  REQUIREMENTS_COOLDOWN_MAX_MS,
  RequirementsGate,
} from '../model-requirements.js'

const MODEL = 'siglip2-b16-224'

function gate(
  overrides: { cooldownBaseMs?: number; cooldownMaxMs?: number; maxAttempts?: number } = {},
) {
  let now = 1_000_000
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const g = new RequirementsGate({
    tower: 'image',
    nodeId: () => 'agent-b',
    logger,
    now: () => now,
    ...overrides,
  })
  return {
    g,
    logger,
    advance: (ms: number) => {
      now += ms
    },
    refuseOnce: (err: unknown = new Error('ModelDownloadService: hub unreachable')) =>
      g.refuse(MODEL, err),
  }
}

/** Throws-or-not, as a value. */
function checkResult(g: RequirementsGate, modelId = MODEL): unknown {
  try {
    g.check(modelId)
    return null
  } catch (err) {
    return err
  }
}

describe('RequirementsGate — cooldown, consulted on demand', () => {
  it('a model nobody has failed passes check() — nothing to consult', () => {
    const { g } = gate()
    expect(checkResult(g)).toBeNull()
    expect(g.pending()).toEqual([])
  })

  it('after a failed attempt, requests inside the cooldown are refused at once by name; the cooldown is the base', () => {
    const { g, refuseOnce, advance } = gate()
    const first = refuseOnce()
    expect(embeddingRefusalOf(first)).toEqual({
      code: EMBEDDING_REQUIREMENTS_UNAVAILABLE,
      modelId: MODEL,
      tower: 'image',
      nodeId: 'agent-b',
    })
    expect(String(first)).toContain('hub unreachable')
    const inside = checkResult(g)
    expect(embeddingRefusalOf(inside)?.code).toBe(EMBEDDING_REQUIREMENTS_UNAVAILABLE)
    expect(String(inside)).toMatch(/retry in \d+s — .*hub unreachable/)
    advance(REQUIREMENTS_COOLDOWN_BASE_MS - 1)
    expect(checkResult(g)).not.toBeNull()
    advance(1)
    expect(checkResult(g)).toBeNull() // the cooldown has elapsed: the next request may build
  })

  it('the cooldown doubles per failed attempt and stops at the cap', () => {
    const { g, refuseOnce, advance } = gate()
    const expected: number[] = []
    for (let i = 0; i < 12; i++) {
      expected.push(Math.min(REQUIREMENTS_COOLDOWN_MAX_MS, REQUIREMENTS_COOLDOWN_BASE_MS * 2 ** i))
    }
    for (const cooldown of expected) {
      refuseOnce()
      advance(cooldown - 1)
      expect(checkResult(g)).not.toBeNull()
      advance(1)
      expect(checkResult(g)).toBeNull()
    }
    expect(expected.at(-1)).toBe(REQUIREMENTS_COOLDOWN_MAX_MS)
  })

  it('a transient failure NEVER goes terminal, however many attempts', () => {
    const { g, refuseOnce, advance, logger } = gate()
    for (let i = 0; i < 10; i++) {
      expect(embeddingRefusalOf(refuseOnce())?.code).toBe(EMBEDDING_REQUIREMENTS_UNAVAILABLE)
      advance(REQUIREMENTS_COOLDOWN_MAX_MS)
    }
    expect(g.failed()).toEqual([])
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1) // the transition, not the ten attempts
  })

  it('success clears the cooldown and logs the recovery once, with the refused and attempt counts', () => {
    const { g, refuseOnce, logger } = gate()
    refuseOnce()
    checkResult(g) // one request refused inside the cooldown
    checkResult(g)
    g.satisfied(MODEL)
    expect(g.pending()).toEqual([])
    expect(checkResult(g)).toBeNull()
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      'CLIP model requirements available again',
      expect.objectContaining({
        meta: expect.objectContaining({
          modelId: MODEL,
          nodeId: 'agent-b',
          refused: 3,
          attempts: 1,
        }),
      }),
    )
    g.satisfied(MODEL) // idempotent: nothing to log
    expect(logger.info).toHaveBeenCalledTimes(1)
  })
})

describe('RequirementsGate — a requirement that can NEVER be met is terminal after N attempts (D6)', () => {
  const permanent = () =>
    new PermanentRequirementsFailure('HTTP 404 downloading https://x/model.onnx')

  it(`goes terminal on attempt ${String(MAX_REQUIREMENTS_ATTEMPTS)}: refused by its own code, listed with its node, ONE error logged`, () => {
    const { g, refuseOnce, advance, logger } = gate()
    for (let i = 1; i < MAX_REQUIREMENTS_ATTEMPTS; i++) {
      expect(embeddingRefusalOf(refuseOnce(permanent()))?.code).toBe(
        EMBEDDING_REQUIREMENTS_UNAVAILABLE,
      )
      advance(REQUIREMENTS_COOLDOWN_MAX_MS)
    }
    expect(g.failed()).toEqual([])
    const terminal = refuseOnce(permanent())
    expect(embeddingRefusalOf(terminal)?.code).toBe(EMBEDDING_REQUIREMENTS_FAILED)
    expect(String(terminal)).toContain('resetFailedModels')
    expect(g.failed()).toEqual([
      expect.objectContaining({
        modelId: MODEL,
        tower: 'image',
        nodeId: 'agent-b',
        attempts: MAX_REQUIREMENTS_ATTEMPTS,
        lastReason: expect.stringContaining('404'),
      }),
    ])
    expect(logger.error).toHaveBeenCalledTimes(1)
    // No cooldown ever ends it: a request a day later is still refused, no build.
    advance(24 * 3_600_000)
    expect(embeddingRefusalOf(checkResult(g))?.code).toBe(EMBEDDING_REQUIREMENTS_FAILED)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('only PERMANENT failures count toward the bound: two transient then one permanent is not terminal', () => {
    const { g, refuseOnce, advance, logger } = gate({ maxAttempts: 3 })
    refuseOnce() // outage
    advance(REQUIREMENTS_COOLDOWN_MAX_MS)
    refuseOnce() // outage
    advance(REQUIREMENTS_COOLDOWN_MAX_MS)
    expect(embeddingRefusalOf(refuseOnce(permanent()))?.code).toBe(
      EMBEDDING_REQUIREMENTS_UNAVAILABLE,
    )
    expect(g.failed()).toEqual([])
    advance(REQUIREMENTS_COOLDOWN_MAX_MS)
    refuseOnce(permanent())
    advance(REQUIREMENTS_COOLDOWN_MAX_MS)
    expect(logger.error).not.toHaveBeenCalled()
    expect(embeddingRefusalOf(refuseOnce(permanent()))?.code).toBe(EMBEDDING_REQUIREMENTS_FAILED)
    expect(g.failed()).toEqual([expect.objectContaining({ modelId: MODEL, attempts: 3 })])
  })

  it('a permanent failure below the bound only cools down — a 404 during a registry publish is given its attempts', () => {
    const { g, refuseOnce } = gate({ maxAttempts: 3 })
    refuseOnce(permanent())
    expect(g.failed()).toEqual([])
    expect(embeddingRefusalOf(checkResult(g))?.code).toBe(EMBEDDING_REQUIREMENTS_UNAVAILABLE)
  })

  it('reset clears the terminal state (and a cooldown) and names what was TERMINAL; a model change does the same for one model', () => {
    const { g, refuseOnce, advance, logger } = gate({ maxAttempts: 1 })
    refuseOnce(permanent())
    expect(g.failed()).toHaveLength(1)
    g.refuse('test-clip-a', new Error('transient')) // only a cooldown
    expect(g.reset(undefined, 'operator')).toEqual([MODEL]) // the cooldown is not a state the operator is told about
    expect(g.failed()).toEqual([])
    expect(g.pending()).toEqual([])
    expect(checkResult(g)).toBeNull()
    expect(checkResult(g, 'test-clip-a')).toBeNull()
    expect(logger.info).toHaveBeenCalledWith(
      'CLIP model requirements-failed state cleared',
      expect.objectContaining({
        meta: expect.objectContaining({ cleared: [MODEL], why: 'operator' }),
      }),
    )
    // Per model: the other one keeps its state.
    refuseOnce(permanent())
    g.refuse('test-clip-a', permanent())
    expect(g.reset('test-clip-a', 'model-change')).toEqual(['test-clip-a'])
    expect(g.failed().map((f) => f.modelId)).toEqual([MODEL])
    advance(0)
  })
})
