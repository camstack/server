/**
 * D783 — a Zod config field is a secret because it says so:
 * `.meta({ secret: true })`. Never because of its name.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodEntriesToConfigUI } from '../zod-to-config-ui.js'
import { collectZodSecretPaths, isZodSecret, SECRET_META } from '../zod-secret.js'

describe('isZodSecret', () => {
  it('reads the declaration through every wrapper, whichever side it was put on', () => {
    expect(isZodSecret(z.string().meta(SECRET_META))).toBe(true)
    expect(isZodSecret(z.string().meta(SECRET_META).default(''))).toBe(true)
    expect(isZodSecret(z.string().default('').meta(SECRET_META))).toBe(true)
    expect(isZodSecret(z.string().optional().meta(SECRET_META))).toBe(true)
    expect(isZodSecret(z.string().meta(SECRET_META).nullable().optional())).toBe(true)
    expect(isZodSecret(z.preprocess((v) => v, z.string().meta(SECRET_META)).describe('d'))).toBe(
      true,
    )
  })

  it('never decides by name', () => {
    expect(isZodSecret(z.string())).toBe(false)
    expect(isZodSecret(z.string().describe('the password'))).toBe(false)
    expect(isZodSecret(z.string().meta({ secret: false }))).toBe(false)
  })
})

describe('collectZodSecretPaths', () => {
  it('lists declared leaves at any depth, `[]` for array items', () => {
    const schema = z.object({
      host: z.string(),
      password: z.string(), // name alone does not count
      localKey: z.string().meta(SECRET_META),
      connection: z.object({
        host: z.string(),
        apiKey: z.string().default('').meta(SECRET_META),
        nested: z.object({ pin: z.string().meta(SECRET_META).optional() }).optional(),
      }),
      rows: z.array(z.object({ name: z.string(), token: z.string().meta(SECRET_META) })),
      wholeBlob: z.object({ a: z.string() }).meta(SECRET_META),
    })
    expect([...collectZodSecretPaths(schema)].sort()).toEqual([
      'connection.apiKey',
      'connection.nested.pin',
      'localKey',
      'rows[].token',
      'wholeBlob',
    ])
  })

  it('descends into (discriminated) unions and intersections', () => {
    const local = z.object({
      transport: z.literal('local'),
      password: z.string().meta(SECRET_META),
    })
    const listener = z.object({ transport: z.literal('listener'), port: z.number() })
    const schema = z.object({
      connection: z.discriminatedUnion('transport', [local, listener]),
      both: z.intersection(
        z.object({ a: z.string() }),
        z.object({ key: z.string().meta(SECRET_META) }),
      ),
    })
    expect([...collectZodSecretPaths(schema)].sort()).toEqual(['both.key', 'connection.password'])
  })

  it('returns nothing for a schema that declares nothing', () => {
    expect(collectZodSecretPaths(z.object({ a: z.string() }))).toEqual([])
    expect(collectZodSecretPaths(z.string())).toEqual([])
  })
})

describe('zodEntriesToConfigUI honours the declaration', () => {
  it('renders a declared string as a password field whatever its name', () => {
    const ui = zodEntriesToConfigUI([
      { key: 'localKey', schema: z.string().meta(SECRET_META), value: 'x' },
      { key: 'navigationAccessCode', schema: z.string().optional().meta(SECRET_META), value: 'y' },
    ])
    const fields = ui.sections.flatMap((s) => s.fields)
    expect(fields.map((f) => f.type)).toEqual(['password', 'password'])
  })

  it('marks a JSON object field secret when anything inside it is declared', () => {
    const ui = zodEntriesToConfigUI([
      {
        key: 'connection',
        schema: z.object({ host: z.string(), password: z.string().meta(SECRET_META) }),
        value: {},
      },
      { key: 'plain', schema: z.object({ host: z.string() }), value: {} },
    ])
    const [connection, plain] = ui.sections.flatMap((s) => s.fields)
    expect(connection).toMatchObject({ type: 'textarea', secret: true })
    expect(plain && 'secret' in plain ? plain.secret : undefined).toBeUndefined()
  })
})
