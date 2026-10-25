import { describe, it, expect } from 'vitest'
import type { ConfigPort } from '../config-port.js'

describe('ConfigPort', () => {
  it('a Map-backed adapter satisfies the contract', () => {
    const m = new Map<string, unknown>()
    const port: ConfigPort = {
      get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
      set: (k, v) => void m.set(k, v),
    }
    port.set('a.b', 'x')
    expect(port.get('a.b')).toBe('x')
  })

  it('supports an async (storage-backed) set', async () => {
    const m = new Map<string, unknown>()
    const port: ConfigPort = {
      get: <T>(k: string): T | undefined => m.get(k) as T | undefined,
      set: async (k, v) => {
        await Promise.resolve()
        m.set(k, v)
      },
    }
    await port.set('a.b', 42)
    expect(port.get<number>('a.b')).toBe(42)
  })
})
