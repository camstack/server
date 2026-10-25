import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { deviceCustomAction } from '../capabilities/custom-actions.js'

describe('deviceCustomAction', () => {
  it('produces a device-scoped spec with the given schemas + mutation kind', () => {
    const spec = deviceCustomAction(z.object({}), z.void(), { kind: 'mutation' })
    expect(spec.scope.kind).toBe('device')
    expect(spec.kind).toBe('mutation')
    expect(spec.auth).toBe('protected')
  })

  it('defaults to query kind + protected auth', () => {
    const spec = deviceCustomAction(z.object({}), z.void())
    expect(spec.kind).toBe('query')
    expect(spec.auth).toBe('protected')
  })

  it('carries deviceTypes when provided', () => {
    const spec = deviceCustomAction(z.object({}), z.void(), { deviceTypes: [] })
    expect(spec.scope.kind).toBe('device')
  })
})
