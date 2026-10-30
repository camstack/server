/**
 * A kind whose discovery needs credentials it was not given answers "nothing to
 * search" (an empty list), never an error. The Find notifiers dialog asks every
 * discoverable kind with an empty config; an error here shows up as a failure
 * for a kind the operator simply has not set up.
 */
import { describe, expect, it } from 'vitest'
import { buildNotifierAdapters } from '../adapters/registry.js'

const discoverable = buildNotifierAdapters().filter((adapter) => adapter.discover !== undefined)

describe('discover with an empty config', () => {
  it('covers at least the credential-gated kinds', () => {
    expect(discoverable.length).toBeGreaterThanOrEqual(4)
  })

  for (const adapter of discoverable) {
    it(`${adapter.descriptor.kind} answers [] instead of throwing`, async () => {
      await expect(adapter.discover?.({})).resolves.toEqual([])
    })
  }
})
