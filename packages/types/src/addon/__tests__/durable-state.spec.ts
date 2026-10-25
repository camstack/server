import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createDurableState } from '../durable-state.js'

const Schema = z.object({ a: z.number(), b: z.string().optional() })
type Shape = z.infer<typeof Schema>

function fakeStore(initial: Record<string, unknown> = {}) {
  let store = { ...initial }
  return {
    read: vi.fn(async () => ({ ...store })),
    write: vi.fn(async (patch: Record<string, unknown>) => {
      store = { ...store, ...patch }
    }),
    snapshot: () => store,
  }
}

describe('createDurableState', () => {
  it('returns fallback when the key is absent', async () => {
    const s = fakeStore()
    const h = createDurableState<Shape>({
      key: 'k',
      schema: Schema,
      fallback: { a: 0 },
      read: s.read,
      write: s.write,
    })
    expect(await h.get()).toEqual({ a: 0 })
  })

  it('parses a stored value', async () => {
    const s = fakeStore({ k: { a: 7, b: 'x' } })
    const h = createDurableState<Shape>({
      key: 'k',
      schema: Schema,
      fallback: { a: 0 },
      read: s.read,
      write: s.write,
    })
    expect(await h.get()).toEqual({ a: 7, b: 'x' })
  })

  it('set writes the WHOLE validated value under the key and leaves siblings intact', async () => {
    const s = fakeStore({ other: 'keep' })
    const h = createDurableState<Shape>({
      key: 'k',
      schema: Schema,
      fallback: { a: 0 },
      read: s.read,
      write: s.write,
    })
    await h.set({ a: 1, b: 'y' })
    expect(s.snapshot()).toEqual({ other: 'keep', k: { a: 1, b: 'y' } })
  })

  it('update round-trips prev → next', async () => {
    const s = fakeStore({ k: { a: 1 } })
    const h = createDurableState<Shape>({
      key: 'k',
      schema: Schema,
      fallback: { a: 0 },
      read: s.read,
      write: s.write,
    })
    await h.update((prev) => ({ ...prev, a: prev.a + 41 }))
    expect(await h.get()).toEqual({ a: 42 })
  })

  it('set rejects schema-invalid input (does not persist)', async () => {
    const s = fakeStore()
    const h = createDurableState<Shape>({
      key: 'k',
      schema: Schema,
      fallback: { a: 0 },
      read: s.read,
      write: s.write,
    })
    await expect(h.set({ a: 'nope' } as unknown as Shape)).rejects.toThrow()
    expect(s.write).not.toHaveBeenCalled()
  })

  it('get returns fallback + calls onParseError on a corrupt blob (never throws)', async () => {
    const s = fakeStore({ k: { a: 'corrupt' } })
    const onParseError = vi.fn()
    const h = createDurableState<Shape>({
      key: 'k',
      schema: Schema,
      fallback: { a: -1 },
      read: s.read,
      write: s.write,
      onParseError,
    })
    expect(await h.get()).toEqual({ a: -1 })
    expect(onParseError).toHaveBeenCalledWith('k', expect.anything())
  })

  it('parses a legacy partial blob missing a now-optional field', async () => {
    const s = fakeStore({ k: { a: 5 } }) // no `b`
    const h = createDurableState<Shape>({
      key: 'k',
      schema: Schema,
      fallback: { a: 0 },
      read: s.read,
      write: s.write,
    })
    expect(await h.get()).toEqual({ a: 5 })
  })
})
