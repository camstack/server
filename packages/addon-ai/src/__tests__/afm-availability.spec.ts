import type { AppleFmAvailability } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HelperOutcome } from '../runtime/apple/afm-helper.js'
import {
  AppleFmAvailabilityMirror,
  type AppleFmAvailabilityDeps,
  type AvailabilityHelper,
} from '../runtime/apple/afm-availability.js'
import { createTestLogger, makeTestLogger } from './support/logger.js'

const AVAILABLE: AppleFmAvailability = {
  state: 'available',
  osVersion: '26.3.1',
  contextSize: 4096,
  languages: ['en-US', 'it-IT'],
  imageInput: false,
}

function probeReply(availability: AppleFmAvailability): HelperOutcome {
  return { kind: 'reply', reply: { id: 'afm-1', ok: true, protocol: 1, availability } }
}

interface ScriptedHelper {
  readonly helper: AvailabilityHelper
  readonly calls: { count: number }
}

function scriptedHelper(...outcomes: HelperOutcome[]): ScriptedHelper {
  const calls = { count: 0 }
  const helper: AvailabilityHelper = {
    request: async () => {
      const outcome = outcomes[Math.min(calls.count, outcomes.length - 1)]
      calls.count += 1
      if (outcome === undefined) throw new Error('no scripted outcome')
      return outcome
    },
  }
  return { helper, calls }
}

function mirror(
  helper: AvailabilityHelper,
  overrides: Partial<AppleFmAvailabilityDeps> = {},
): AppleFmAvailabilityMirror {
  return new AppleFmAvailabilityMirror({
    platform: 'darwin',
    arch: 'arm64',
    osRelease: '25.3.0',
    helper,
    logger: makeTestLogger(),
    ...overrides,
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AppleFmAvailabilityMirror', () => {
  it('linux is `unsupported-platform` and never touches the helper', async () => {
    const { helper, calls } = scriptedHelper(probeReply(AVAILABLE))
    const m = mirror(helper, { platform: 'linux' })
    expect(m.current()).toEqual({ state: 'unsupported-platform', platform: 'linux' })
    expect(await m.refresh()).toEqual({ state: 'unsupported-platform', platform: 'linux' })
    expect(calls.count).toBe(0)
  })

  it('an Intel Mac is `unsupported-platform`, never a helper crash', async () => {
    const { helper, calls } = scriptedHelper(probeReply(AVAILABLE))
    const m = mirror(helper, { arch: 'x64' })
    expect(await m.refresh()).toEqual({ state: 'unsupported-platform', platform: 'darwin/x64' })
    expect(calls.count).toBe(0)
  })

  it('a Darwin kernel older than macOS 26 is `osTooOld` without spawning anything', async () => {
    const { helper, calls } = scriptedHelper(probeReply(AVAILABLE))
    const m = mirror(helper, { osRelease: '24.6.0' })
    expect(await m.refresh()).toMatchObject({ state: 'unavailable', reason: 'osTooOld' })
    expect(calls.count).toBe(0)
  })

  it('before any probe answered, the truth is `unknown` — never unavailable (D393)', () => {
    const { helper } = scriptedHelper(probeReply(AVAILABLE))
    expect(mirror(helper).current()).toMatchObject({ state: 'unknown' })
  })

  it('a probe that answers becomes the mirror', async () => {
    const { helper } = scriptedHelper(probeReply(AVAILABLE))
    const m = mirror(helper)
    expect(await m.refresh()).toEqual(AVAILABLE)
    expect(m.current()).toEqual(AVAILABLE)
  })

  it('a probe that times out or crashes is `unknown`, not unavailable', async () => {
    const timedOut = mirror(scriptedHelper({ kind: 'timeout' }).helper)
    expect(await timedOut.refresh()).toMatchObject({ state: 'unknown' })
    const crashed = mirror(scriptedHelper({ kind: 'crashed', detail: 'exit 1' }).helper)
    expect(await crashed.refresh()).toMatchObject({ state: 'unknown' })
  })

  it('a reply that does not fit the contract is `unknown`, never trusted', async () => {
    const { helper } = scriptedHelper({
      kind: 'reply',
      reply: { id: 'afm-1', ok: true, protocol: 1, availability: { state: 'available' } },
    })
    expect(await mirror(helper).refresh()).toMatchObject({ state: 'unknown' })
  })

  it('a missing or crash-bounded helper is a KNOWN absence with its reason', async () => {
    const missing = mirror(
      scriptedHelper({ kind: 'unavailable', reason: 'helperMissing', detail: 'no binary' }).helper,
    )
    expect(await missing.refresh()).toMatchObject({
      state: 'unavailable',
      reason: 'helperMissing',
      detail: 'no binary',
    })
  })

  it('serve-and-revalidate: a read answers the slice and starts a refresh, never joins one', async () => {
    let release: (outcome: HelperOutcome) => void = () => {}
    let calls = 0
    const helper: AvailabilityHelper = {
      request: () => {
        calls += 1
        return new Promise<HelperOutcome>((resolve) => {
          release = resolve
        })
      },
    }
    const m = mirror(helper)
    expect(m.current()).toMatchObject({ state: 'unknown' })
    expect(calls).toBe(1)
    // A second read while the probe is in flight neither waits nor probes again.
    expect(m.current()).toMatchObject({ state: 'unknown' })
    expect(calls).toBe(1)
    release(probeReply(AVAILABLE))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(m.current()).toEqual(AVAILABLE)
  })

  it('a fresh slice is served without re-probing', async () => {
    const { helper, calls } = scriptedHelper(probeReply(AVAILABLE))
    let now = 1_000
    const m = mirror(helper, { now: () => now, revalidateMs: 60_000 })
    await m.refresh()
    now += 10_000
    m.current()
    expect(calls.count).toBe(1)
    now += 60_000
    m.current()
    expect(calls.count).toBe(2)
  })

  it('modelNotReady re-probes on its own, with a bounded backoff', async () => {
    vi.useFakeTimers()
    const notReady: AppleFmAvailability = {
      state: 'unavailable',
      reason: 'modelNotReady',
      osVersion: '26.3.1',
      detail: 'downloading',
    }
    const { helper, calls } = scriptedHelper(probeReply(notReady), probeReply(AVAILABLE))
    const m = mirror(helper, { notReadyBackoff: { initialMs: 1_000, maxMs: 4_000 } })
    await m.refresh()
    expect(calls.count).toBe(1)
    await vi.advanceTimersByTimeAsync(1_001)
    expect(calls.count).toBe(2)
    expect(m.current()).toEqual(AVAILABLE)
    m.dispose()
  })

  it('logs each state TRANSITION once, with the reason', async () => {
    const { logger, entries } = createTestLogger()
    const { helper } = scriptedHelper(probeReply(AVAILABLE))
    const m = mirror(helper, { logger })
    await m.refresh()
    await m.refresh()
    const transitions = entries.filter((e) => e.message.includes('availability changed'))
    expect(transitions).toHaveLength(1)
    expect(transitions[0]?.extras?.meta).toMatchObject({ from: 'unknown', to: 'available' })
  })
})
