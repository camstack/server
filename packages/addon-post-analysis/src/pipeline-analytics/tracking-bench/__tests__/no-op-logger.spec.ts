/**
 * The discard-everything logger tracking-bench code without its own
 * `ctx.logger` uses (D681 fix round 1, L1). Every level is silent, and
 * `child`/`withTags` return a logger of the same shape so a caller that
 * chains does not crash.
 */
import { describe, expect, it } from 'vitest'
import { createNoopLogger } from '../no-op-logger.js'

describe('createNoopLogger', () => {
  it('never throws on any level, and chains to itself', () => {
    const logger = createNoopLogger()
    expect(() => logger.debug('x')).not.toThrow()
    expect(() => logger.info('x')).not.toThrow()
    expect(() => logger.warn('x')).not.toThrow()
    expect(() => logger.error('x')).not.toThrow()
    expect(logger.child('scope')).toBe(logger)
    expect(logger.withTags({ deviceId: 1 })).toBe(logger)
  })
})
