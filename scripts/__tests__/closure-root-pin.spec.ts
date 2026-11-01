import { describe, expect, it } from 'vitest'
import { closureRootPinProblem } from '../closure-root-pin.js'

describe('closureRootPinProblem', () => {
  it('accepts the exact patched version', () => {
    expect(closureRootPinProblem({ werift: '0.22.9' }, 'werift', '0.22.9')).toBeNull()
  })
  it('refuses a closure root that does not declare the package (the 1.2.723 shape)', () => {
    expect(closureRootPinProblem({ 'node-av': '^6.0.0' }, 'werift', '0.22.9')).toContain('found nothing')
  })
  it('refuses a range that admits other versions', () => {
    expect(closureRootPinProblem({ werift: '^0.22.9' }, 'werift', '0.22.9')).toContain('"^0.22.9"')
  })
})
