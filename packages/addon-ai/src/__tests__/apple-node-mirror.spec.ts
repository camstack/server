import type { AppleFmAvailability } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppleNodeMirror, type AppleNodeSource } from '../apple-node-mirror.js'
import { createTestLogger, makeTestLogger } from './support/logger.js'

const AVAILABLE: AppleFmAvailability = {
  state: 'available',
  osVersion: '27.2.0',
  contextSize: 8192,
  languages: ['it-IT'],
  imageInput: false,
}

function source(overrides: Partial<AppleNodeSource> = {}): {
  src: AppleNodeSource
  asked: string[]
} {
  const asked: string[] = []
  const src: AppleNodeSource = {
    listRegisteredRuntimeNodeIds: async () => ['mac', 'hub'],
    appleAvailability: async (nodeId) => {
      asked.push(nodeId)
      return nodeId === 'mac' ? AVAILABLE : { state: 'unsupported-platform', platform: 'linux' }
    },
    ...overrides,
  }
  return { src, asked }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AppleNodeMirror', () => {
  it('a read never waits: before any refresh every node is unknown', () => {
    const m = new AppleNodeMirror({ source: source().src, logger: makeTestLogger() })
    expect(m.get('mac')).toBeUndefined()
  })

  it('a refresh fills the mirror from the nodes the REGISTRY lists', async () => {
    const { src, asked } = source()
    const m = new AppleNodeMirror({ source: src, logger: makeTestLogger() })
    await m.refresh()
    expect(m.get('mac')).toEqual(AVAILABLE)
    expect(m.get('hub')).toEqual({ state: 'unsupported-platform', platform: 'linux' })
    expect(asked.toSorted()).toEqual(['hub', 'mac'])
  })

  it('a node the registry does not list is never asked, and after TWO reads is known OFFLINE', async () => {
    const { src, asked } = source({ listRegisteredRuntimeNodeIds: async () => ['hub'] })
    const m = new AppleNodeMirror({ source: src, logger: makeTestLogger() })
    await m.refresh()
    expect(asked).toEqual(['hub'])
    expect(m.isKnownOffline('mac')).toBe(false)
    await m.refresh()
    expect(m.get('mac')).toBeUndefined()
    expect(m.isKnownOffline('mac')).toBe(true)
    expect(m.isKnownOffline('hub')).toBe(false)
  })

  it('a re-registration BLIP (missing from one read) never makes a node offline', async () => {
    let listed: readonly string[] = ['mac', 'hub']
    const { src } = source({ listRegisteredRuntimeNodeIds: async () => listed })
    const m = new AppleNodeMirror({ source: src, logger: makeTestLogger() })
    await m.refresh()
    listed = ['hub'] // the Mac's runner respawned; its providers re-register
    await m.refresh()
    expect(m.isKnownOffline('mac')).toBe(false)
    expect(m.get('mac')).toEqual(AVAILABLE) // the slice survives the blip
    listed = ['mac', 'hub']
    await m.refresh()
    expect(m.isKnownOffline('mac')).toBe(false)
    listed = ['hub']
    await m.refresh()
    await m.refresh()
    expect(m.isKnownOffline('mac')).toBe(true)
  })

  it('a node that first goes missing is re-checked within seconds, not a full period later', async () => {
    let now = 0
    let reads = 0
    let listed: readonly string[] = ['mac']
    const { src } = source({
      listRegisteredRuntimeNodeIds: async () => {
        reads += 1
        return listed
      },
    })
    const m = new AppleNodeMirror({
      source: src,
      logger: makeTestLogger(),
      staleMs: 30_000,
      confirmAbsenceMs: 2_000,
      now: () => now,
    })
    await m.refresh()
    listed = []
    now = 30_000
    m.get('mac')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(reads).toBe(2)
    now = 31_000
    m.get('mac')
    expect(reads).toBe(2) // still inside the confirmation window
    now = 32_001
    m.get('mac')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(reads).toBe(3)
    expect(m.isKnownOffline('mac')).toBe(true)
  })

  it('a registry with no llm-runtime entry (null) is NO answer: nothing changes', async () => {
    let answer: readonly string[] | null = ['mac']
    const { src } = source({ listRegisteredRuntimeNodeIds: async () => answer })
    const m = new AppleNodeMirror({ source: src, logger: makeTestLogger() })
    await m.refresh()
    answer = null
    await m.refresh()
    await m.refresh()
    expect(m.isKnownOffline('mac')).toBe(false)
    expect(m.get('mac')).toEqual(AVAILABLE)
  })

  it('a failed registry read backs off: readers do not re-trigger it on every call', async () => {
    let now = 0
    let reads = 0
    const { src } = source({
      listRegisteredRuntimeNodeIds: async () => {
        reads += 1
        throw new Error('registry down')
      },
    })
    const m = new AppleNodeMirror({
      source: src,
      logger: makeTestLogger(),
      staleMs: 30_000,
      now: () => now,
    })
    await m.refresh()
    for (let i = 0; i < 5; i++) {
      now += 1_000
      m.get('mac')
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(reads).toBe(1)
    now += 30_000
    m.get('mac')
    expect(reads).toBe(2)
  })

  it('a registry read that never answers is bounded, and frees the refresh slot', async () => {
    vi.useFakeTimers()
    let reads = 0
    const { src } = source({
      listRegisteredRuntimeNodeIds: () => {
        reads += 1
        return new Promise<readonly string[]>(() => {})
      },
    })
    let now = 0
    const m = new AppleNodeMirror({
      source: src,
      logger: makeTestLogger(),
      registryTimeoutMs: 3_000,
      staleMs: 10_000,
      now: () => now,
    })
    const first = m.refresh()
    await vi.advanceTimersByTimeAsync(3_001)
    await first // settles: the in-progress flag is cleared
    now = 20_000
    m.get('mac')
    expect(reads).toBe(2)
  })

  it('a registry read that fails changes nothing (D49)', async () => {
    let fail = false
    const { src } = source({
      listRegisteredRuntimeNodeIds: async () => {
        if (fail) throw new Error('registry down')
        return ['mac']
      },
    })
    const m = new AppleNodeMirror({ source: src, logger: makeTestLogger() })
    await m.refresh()
    fail = true
    await m.refresh()
    expect(m.get('mac')).toEqual(AVAILABLE)
    expect(m.isKnownOffline('mac')).toBe(false)
  })

  it('a node that never answers is bounded by a deadline and becomes unknown', async () => {
    vi.useFakeTimers()
    const handle = createTestLogger()
    const { src } = source({ appleAvailability: () => new Promise<AppleFmAvailability>(() => {}) })
    const m = new AppleNodeMirror({ source: src, logger: handle.logger, askTimeoutMs: 1_000 })
    const done = m.refresh()
    await vi.advanceTimersByTimeAsync(1_001)
    await done
    expect(m.get('mac')).toMatchObject({ state: 'unknown' })
  })

  it('a stale read starts ONE background refresh and still answers at once', async () => {
    let calls = 0
    let now = 0
    const { src } = source({
      listRegisteredRuntimeNodeIds: async () => {
        calls += 1
        return ['mac']
      },
    })
    const m = new AppleNodeMirror({
      source: src,
      logger: makeTestLogger(),
      staleMs: 1_000,
      now: () => now,
    })
    expect(m.get('mac')).toBeUndefined()
    expect(m.get('mac')).toBeUndefined()
    expect(calls).toBe(1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(m.get('mac')).toEqual(AVAILABLE)
    now = 500
    m.get('mac')
    expect(calls).toBe(1)
    now = 2_000
    m.get('mac')
    expect(calls).toBe(2)
  })

  it('an answer observed elsewhere (the runtimes page) lands in the mirror', () => {
    const m = new AppleNodeMirror({ source: source().src, logger: makeTestLogger() })
    m.observe('mac', AVAILABLE)
    expect(m.get('mac')).toEqual(AVAILABLE)
  })
})
