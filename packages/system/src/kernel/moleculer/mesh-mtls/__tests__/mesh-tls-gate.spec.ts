import { describe, expect, it } from 'vitest'
import { openMeshTlsWhenRevocationsLoaded } from '../mesh-tls-gate.js'

describe('mesh TLS gate (revocations before agents)', () => {
  it('SECURITY: keeps the listener CLOSED while the registry cannot load, then opens exactly once', async () => {
    const opened: string[] = []
    const retries: Array<() => void> = []
    let available = false
    let attempts = 0
    const waiting: number[] = []
    const first = await openMeshTlsWhenRevocationsLoaded({
      loadRegistry: async () => {
        attempts += 1
        return available ? 'registry' : null
      },
      open: async (r) => void opened.push(r),
      retry: (fn) => void retries.push(fn),
      onWaiting: (n) => void waiting.push(n),
    })
    expect(first).toBe(false)
    expect(opened).toEqual([]) // no agent is accepted with an empty CRL
    expect(waiting).toEqual([1])

    retries.shift()?.() // still down
    await new Promise((r) => setImmediate(r))
    expect(opened).toEqual([])
    expect(waiting).toEqual([1, 2])

    available = true
    retries.shift()?.()
    await new Promise((r) => setImmediate(r))
    expect(opened).toEqual(['registry'])
    expect(attempts).toBe(3)
    expect(retries).toHaveLength(0)
  })

  it('a registry load that THROWS is the same as unavailable (closed, reported, retried)', async () => {
    const errors: unknown[] = []
    let retried = 0
    const opened: number[] = []
    await openMeshTlsWhenRevocationsLoaded({
      loadRegistry: async () => {
        throw new Error('store down')
      },
      open: async () => void opened.push(1),
      retry: () => {
        retried += 1
      },
      onError: (e) => void errors.push(e),
    })
    expect(opened).toEqual([])
    expect(errors).toHaveLength(1)
    expect(retried).toBe(1)
  })

  it('a failed open() is retried (never an unhandled rejection) and the state says closed, then open', async () => {
    const states: string[] = []
    const retries: Array<() => void> = []
    let opens = 0
    const errors: unknown[] = []
    const result = await openMeshTlsWhenRevocationsLoaded({
      loadRegistry: async () => 'registry',
      open: async () => {
        opens += 1
        if (opens === 1) throw new Error('listener port busy')
      },
      retry: (fn) => void retries.push(fn),
      onError: (e) => void errors.push(e),
      onState: (s) => void states.push(s.state === 'closed' ? `closed: ${s.reason}` : 'open'),
      now: () => 42,
    })
    expect(result).toBe(false) // resolved, did not reject
    expect(errors).toHaveLength(1)
    expect(states).toEqual(['closed: the listener failed to open - retrying'])
    retries.shift()?.()
    await new Promise((r) => setImmediate(r))
    expect(opens).toBe(2)
    expect(states.at(-1)).toBe('open')
  })

  it('reports the closed state (with a reason and since) while the registry is missing', async () => {
    const seen: Array<{ state: string; reason?: string; since?: number }> = []
    await openMeshTlsWhenRevocationsLoaded({
      loadRegistry: async () => null,
      open: async () => undefined,
      retry: () => undefined,
      onState: (s) => void seen.push(s),
      now: () => 1234,
    })
    expect(seen).toEqual([
      { state: 'closed', reason: expect.stringContaining('revocation registry'), since: 1234 },
    ])
  })
})
