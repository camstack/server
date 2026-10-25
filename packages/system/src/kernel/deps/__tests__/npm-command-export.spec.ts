import { describe, expect, it } from 'vitest'
import * as system from '../../../index.js'

describe('npm-command public surface', () => {
  it('re-exports runNpm and resolveNpmInvocation', () => {
    expect(typeof system.runNpm).toBe('function')
    expect(typeof system.resolveNpmInvocation).toBe('function')
  })
})
