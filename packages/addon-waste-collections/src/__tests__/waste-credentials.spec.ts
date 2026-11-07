/**
 * D880 - a waste source's credential arguments (password, api_key, token, authorization) are
 * declared once, and every catalog service's credential-looking argument is either listed secret
 * or reviewed as not. The keychain round trip is pinned by waste-source-instances.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import catalogJson from '../catalog.json'
import { findCatalogService, serviceFormSchema } from '../waste-catalog.js'
import {
  isSecretArg,
  REVIEWED_NON_SECRET_ARG_KEYS,
  SECRET_ARG_KEYS,
  WASTE_SECRET_STATE_PATHS,
} from '../waste-secrets.js'

const SERVICE_ID = 'recyclesmart_com--recyclesmart'

describe('the catalog and the credential list', () => {
  it('every credential-looking argument of every service is listed secret or reviewed as not', () => {
    const looksLikeCredential =
      /pass|pwd|secret|token|api_?key|auth|cred|bearer|cookie|(^|_)key$|(^|_)pin$/i
    const unknown = new Set<string>()
    for (const service of catalogJson.services) {
      for (const field of service.fields) {
        if (!looksLikeCredential.test(field.key)) continue
        if (SECRET_ARG_KEYS.includes(field.key)) continue
        if (field.key in REVIEWED_NON_SECRET_ARG_KEYS) continue
        unknown.add(field.key)
      }
    }
    expect([...unknown]).toEqual([])
  })

  it('matching is case-insensitive, and no catalog key escapes by its case', () => {
    expect(isSecretArg('PIN')).toBe(true)
    expect(isSecretArg('Account_Pin')).toBe(true)
    const escaped = new Set<string>()
    for (const service of catalogJson.services) {
      for (const field of service.fields) {
        if (isSecretArg(field.key) && !SECRET_ARG_KEYS.includes(field.key)) escaped.add(field.key)
      }
    }
    expect([...escaped]).toEqual([])
  })

  it('a credential argument renders as a password field', () => {
    const service = findCatalogService(SERVICE_ID)
    expect(service).toBeDefined()
    const fields = serviceFormSchema(service!).sections.flatMap((s) => s.fields)
    expect(fields.find((f) => 'key' in f && f.key === 'password')).toMatchObject({
      type: 'password',
    })
  })

  it('the state paths cover exactly the listed keys', () => {
    expect(WASTE_SECRET_STATE_PATHS).toEqual(SECRET_ARG_KEYS.map((k) => `sources[id].args.${k}`))
  })
})
