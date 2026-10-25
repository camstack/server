import type { IScopedLogger, SceneConfirm } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { callDeferredRelease } from '../../../__tests__/support/vitest-mock.js'
import { mergeSilentLogger } from '../../__tests__/test-helpers.js'
import { SceneConfirmGate, type SceneVisionResult } from '../scene-confirm-gate.js'

function logger(): IScopedLogger {
  return mergeSilentLogger({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })
}

function confirm(overrides: Partial<SceneConfirm> = {}): SceneConfirm {
  return {
    enabled: true,
    prompt: 'Is the wheelie bin still there?',
    timeoutMs: 1_000,
    maxImagePx: 448,
    onTimeout: 'hold',
    ...overrides,
  }
}

function gate(generateVision: (i: unknown) => Promise<SceneVisionResult>): {
  gate: SceneConfirmGate
  log: IScopedLogger
} {
  const log = logger()
  return {
    gate: new SceneConfirmGate({
      logger: log,
      generateVision,
      downscale: async (b) => b,
    }),
    log,
  }
}

const IMAGE = new Uint8Array([1, 2, 3])

function input(
  direction: 'diverged' | 'restored',
  c: SceneConfirm = confirm(),
): Parameters<SceneConfirmGate['judge']>[0] {
  return { deviceId: 102, monitorId: 'm1', direction, image: IMAGE, confirm: c }
}

describe('SceneConfirmGate', () => {
  // The operator writes ONE question describing what NORMAL looks like. The
  // direction is read off the answer, so there is never a second prompt that
  // has to stay the first one's negation.
  it('confirms a divergence when the operator’s description no longer holds', async () => {
    const { gate: g } = gate(async () => ({
      ok: true,
      text: '{"holds": false, "reason": "the kerb is empty"}',
      model: 'qwen3-vl-8b',
    }))
    const v = await g.judge(input('diverged'))
    expect(v.decision).toBe('confirmed')
    expect(v.reason).toBe('the kerb is empty')
  })

  it('HOLDS a divergence when the model can still see the bin', async () => {
    const { gate: g } = gate(async () => ({
      ok: true,
      text: '{"holds": true, "reason": "the green bin is at the kerb"}',
    }))
    const v = await g.judge(input('diverged'))
    expect(v.decision).toBe('held')
  })

  it('confirms a restoration when the description holds again', async () => {
    const { gate: g } = gate(async () => ({ ok: true, text: '{"holds": true, "reason": "back"}' }))
    expect((await g.judge(input('restored'))).decision).toBe('confirmed')
  })

  // The inversion of `NcConfirmGate`, and the reason this is a separate class.
  // A notification suppressed is the worse error there; here a vision model
  // that timed out has NOT told us the bin is gone, and a latch is a stateful
  // claim that costs the operator a trip to reset.
  //
  // NEUTRALIZATION: flip `onNoAnswer`'s default to 'confirmed' and all four of
  // the following go red.
  it('fails CLOSED on a timeout', async () => {
    const { gate: g, log } = gate(
      () => new Promise<SceneVisionResult>(() => undefined), // never resolves
    )
    const v = await g.judge(input('diverged', confirm({ timeoutMs: 1_000 })))
    expect(v.decision).toBe('held')
    expect(v.failure).toBe('timeout')
    expect(g.stats().failedClosed).toBe(1)
    // Never silent: a scene that stopped reporting because the model has been
    // down for a week must be discoverable from the logs alone.
    expect(log.warn).toHaveBeenCalled()
  })

  it('fails CLOSED when the model is unavailable', async () => {
    const { gate: g } = gate(async () => ({ ok: false, code: 'no-profile' }))
    const v = await g.judge(input('diverged'))
    expect(v.decision).toBe('held')
    expect(v.reason).toBe('no vision profile configured')
  })

  it('fails CLOSED on a reply that is not the requested shape', async () => {
    const { gate: g } = gate(async () => ({ ok: true, text: 'I think the bin is gone, probably.' }))
    const v = await g.judge(input('diverged'))
    expect(v.decision).toBe('held')
    expect(v.failure).toBe('unparseable')
  })

  it('fails CLOSED when no crop could be cut', async () => {
    const { gate: g } = gate(async () => ({ ok: true, text: '{"holds": false, "reason": ""}' }))
    const v = await g.judge({ ...input('diverged'), image: null })
    expect(v.decision).toBe('held')
    expect(v.failure).toBe('no-image')
  })

  it('honours onTimeout: "flip" for operators who prefer the opposite', async () => {
    const { gate: g } = gate(() => new Promise<SceneVisionResult>(() => undefined))
    const v = await g.judge(input('diverged', confirm({ onTimeout: 'flip', timeoutMs: 500 })))
    expect(v.decision).toBe('confirmed')
    expect(g.stats().failedClosed).toBe(0)
  })

  it('parses a fenced reply, as the model actually returns them', async () => {
    const { gate: g } = gate(async () => ({
      ok: true,
      text: 'Sure!\n```json\n{"holds": false, "reason": "gone"}\n```',
    }))
    expect((await g.judge(input('diverged'))).decision).toBe('confirmed')
  })

  it('bounds concurrent judgments per camera and HOLDS the overflow', async () => {
    let release: (() => void) | null = null
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const { gate: g } = gate(async () => {
      await blocked
      return { ok: true, text: '{"holds": false, "reason": "gone"}' }
    })
    const inFlight = [
      g.judge(input('diverged')),
      g.judge(input('diverged')),
      g.judge(input('diverged')),
    ]
    // A fourth on the same camera exceeds the bound. Suppressing on "busy" is
    // deliberate: the periodic floor re-proposes the same flip a minute later,
    // so nothing is lost — while committing an unjudged latch because the queue
    // was full is a claim that cannot be retracted.
    const overflow = await g.judge(input('diverged'))
    expect(overflow.decision).toBe('held')
    expect(overflow.failure).toBe('busy')
    callDeferredRelease(release)
    await Promise.all(inFlight)
  })

  it('judges the full-size crop rather than losing the verdict to a resize failure', async () => {
    const seen: number[] = []
    const g = new SceneConfirmGate({
      logger: logger(),
      generateVision: async (i) => {
        seen.push(i.images[0]?.bytes.byteLength ?? -1)
        return { ok: true, text: '{"holds": false, "reason": "gone"}' }
      },
      downscale: async () => {
        throw new Error('sharp exploded')
      },
    })
    expect((await g.judge(input('diverged'))).decision).toBe('confirmed')
    expect(seen).toEqual([IMAGE.byteLength])
  })
})
