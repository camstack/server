import { describe, expect, it } from 'vitest'
import { scrubSecrets, scrubValue } from '../scrub.js'

describe('scrubSecrets', () => {
  it('redacts token-like strings and credential paths', () => {
    const raw =
      'token=tok_abcDEF1234567890 and glsa_ABCDEFGHIJ and Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb path=/Users/me/.camstack/hub.json'
    const out = scrubSecrets(raw)
    expect(out).not.toContain('tok_')
    expect(out).not.toContain('glsa_')
    expect(out).not.toContain('eyJ')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts secret-looking object keys', () => {
    const out = scrubValue({ token: 'secret-value-here', ok: true })
    expect(out).toEqual({ token: '[REDACTED]', ok: true })
  })

  it('keeps the `secret` flag and the secretFields names of a schema, but still redacts a secret VALUE', () => {
    const out = scrubValue({
      fields: [{ key: 'topic', secret: true, required: true }],
      secretFields: ['topic'],
      secret: 'hunter2-the-real-secret',
    })
    expect(out).toEqual({
      fields: [{ key: 'topic', secret: true, required: true }],
      secretFields: ['topic'],
      secret: '[REDACTED]',
    })
  })
})
