import { describe, it, expect, vi } from 'vitest'
import { readModifyWrite, type SettingsRead } from '../settings-read-guard.js'

/**
 * The incident these pin: on 2026-07-31 a UDS stall made a settings read time
 * out, the read answered `{}` like an empty store, and the merge-and-write
 * persisted a blob containing only the patch. The recording configuration for
 * all three recording cameras came back `{"enabled": false, "bands": []}` and
 * two and a half hours of footage were never written.
 */
const ok = (value: Record<string, unknown>): SettingsRead => ({ kind: 'value', value })

describe('readModifyWrite', () => {
  it('REFUSES to write when the read failed — the recording-config loss', async () => {
    const write = vi.fn()
    const onRefused = vi.fn()
    const attempted = await readModifyWrite({
      read: async () => ({ kind: 'failed', error: 'UDS request timed out after 60000ms' }),
      write,
      patch: { enabled: false },
      onRefused,
    })
    expect(attempted).toBe(false)
    expect(write).not.toHaveBeenCalled()
    expect(onRefused).toHaveBeenCalledWith('UDS request timed out after 60000ms')
  })

  it('would have SAVED the bands: the old behaviour wrote the patch alone', async () => {
    // What the store held, and what a single-field patch must not destroy.
    const stored = {
      enabled: true,
      bands: [{ days: [], start: '00:00', end: '00:00', mode: 'continuous' }],
      segmentSeconds: 6,
    }
    const write = vi.fn()
    await readModifyWrite({
      read: async () => ok(stored),
      write,
      patch: { enabled: false },
      onRefused: vi.fn(),
    })
    // Merged, not replaced: `bands` and `segmentSeconds` survive.
    expect(write).toHaveBeenCalledWith({
      enabled: false,
      bands: stored.bands,
      segmentSeconds: 6,
    })
  })

  it('treats a genuine MISS as empty and writes the patch — a real first write', async () => {
    const write = vi.fn()
    const attempted = await readModifyWrite({
      read: async () => ({ kind: 'missing' }),
      write,
      patch: { enabled: true },
      onRefused: vi.fn(),
    })
    expect(attempted).toBe(true)
    expect(write).toHaveBeenCalledWith({ enabled: true })
  })

  it('does not confuse a stored empty object with a failure', async () => {
    const write = vi.fn()
    await readModifyWrite({ read: async () => ok({}), write, patch: { a: 1 }, onRefused: vi.fn() })
    expect(write).toHaveBeenCalledWith({ a: 1 })
  })

  it('lets the patch overwrite an existing field, which is the point of a patch', async () => {
    const write = vi.fn()
    await readModifyWrite({
      read: async () => ok({ a: 1, b: 2 }),
      write,
      patch: { b: 99 },
      onRefused: vi.fn(),
    })
    expect(write).toHaveBeenCalledWith({ a: 1, b: 99 })
  })

  it('propagates a write failure rather than reporting success', async () => {
    await expect(
      readModifyWrite({
        read: async () => ok({ a: 1 }),
        write: async () => {
          throw new Error('store offline')
        },
        patch: { b: 2 },
        onRefused: vi.fn(),
      }),
    ).rejects.toThrow('store offline')
  })
})
