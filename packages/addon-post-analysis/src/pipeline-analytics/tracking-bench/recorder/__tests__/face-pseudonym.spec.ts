/**
 * The hub pseudonym is KEYED (§3.6, review M1). An unkeyed hash of an identity
 * is reversible by dictionary, so the format test alone proves nothing.
 *
 * Disarm: replace `createHmac('sha256', key)` with `createHash('sha256')` —
 * the key-dependence and not-unkeyed tests must fail.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hubFacePseudonymizer } from '../frame-record.js'

const KEY_A = Buffer.alloc(32, 7)
const KEY_B = Buffer.alloc(32, 8)
const LABEL = 'id-alice'

describe('hub face pseudonym', () => {
  it('is h:<12 hex>', () => {
    expect(hubFacePseudonymizer(KEY_A).pseudonym(LABEL)).toMatch(/^h:[0-9a-f]{12}$/)
  })

  it('is stable for one key: two pseudonymizers on the same key agree', () => {
    expect(hubFacePseudonymizer(KEY_A).pseudonym(LABEL)).toBe(
      hubFacePseudonymizer(Buffer.from(KEY_A)).pseudonym(LABEL),
    )
  })

  it('depends on the key', () => {
    expect(hubFacePseudonymizer(KEY_A).pseudonym(LABEL)).not.toBe(
      hubFacePseudonymizer(KEY_B).pseudonym(LABEL),
    )
  })

  it('is not the unkeyed hash of the label', () => {
    const unkeyed = `h:${createHash('sha256').update(LABEL).digest('hex').slice(0, 12)}`
    expect(hubFacePseudonymizer(KEY_A).pseudonym(LABEL)).not.toBe(unkeyed)
  })
})
