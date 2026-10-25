/**
 * `@camstack/types/client` (D721) re-exports values the viewer reads at
 * runtime. A name that stopped existing in the barrel would be `undefined`
 * in the viewer, not a build error there — so every name must resolve here.
 */
import { describe, expect, it } from 'vitest'
import * as client from '../client.js'

describe('the client entry', () => {
  it('re-exports only defined runtime values', () => {
    const names = Object.keys(client)
    expect(names.length).toBeGreaterThan(20)
    const undefinedNames = names.filter(
      (name) => (client as Record<string, unknown>)[name] === undefined,
    )
    expect(undefinedNames).toEqual([])
  })

  it('carries what @camstack/sdk imports at runtime', () => {
    expect(typeof client.SystemMirror).toBe('function')
    expect(typeof client.createSystemProxy).toBe('function')
  })
})
