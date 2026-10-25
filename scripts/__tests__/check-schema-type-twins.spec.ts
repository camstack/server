/**
 * The RE-TIGHTENED form the twin guard accepts as derived:
 * `Omit<z.infer<typeof XSchema>, K> & { …exactly K… }`. Anything else in the
 * `& { … }` is a field the schema does not carry — a twin.
 */
import { describe, expect, it } from 'vitest'
import { retightenedDerivations } from '../check-schema-type-twins.js'

describe('retightenedDerivations', () => {
  it('accepts an override that re-types exactly the omitted keys', () => {
    const src = `export type Kind = Omit<
  z.infer<typeof KindSchema>,
  'connectionSchema' | 'advancedSchema'
> & {
  readonly connectionSchema: ConfigUISchema
  readonly advancedSchema?: ConfigUISchema
}`
    expect([...retightenedDerivations(src)]).toEqual(['Kind'])
  })

  it('refuses an override that ADDS a field the schema does not carry', () => {
    const src = `export type Kind = Omit<z.infer<typeof KindSchema>, 'configSchema'> & {
  readonly configSchema?: ConfigUISchema
  readonly extra: string
}`
    expect(retightenedDerivations(src).size).toBe(0)
  })

  it('refuses an override that leaves an omitted key out (the field silently disappears)', () => {
    const src =
      "export type Kind = Omit<z.infer<typeof KindSchema>, 'a' | 'b'> & { readonly a: string }"
    expect(retightenedDerivations(src).size).toBe(0)
  })

  it('refuses a derivation of ANOTHER schema', () => {
    const src = "export type Kind = Omit<z.infer<typeof OtherSchema>, 'a'> & { readonly a: string }"
    expect(retightenedDerivations(src).size).toBe(0)
  })
})
