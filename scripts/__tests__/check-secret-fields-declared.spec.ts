/**
 * D783 — every credential-named config field is DECLARED secret by its
 * schema. Fixtures pin each rule; the last test runs the real tree.
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { itRealTree } from './lib/real-tree.js'
import {
  ALLOWLIST,
  evaluate,
  findUndeclaredSecretFields,
  scanRepo,
} from '../check-secret-fields-declared.ts'

const scan = (text: string) => findUndeclaredSecretFields('fixture.ts', text).map((f) => f.key)

describe('check-secret-fields-declared rules', () => {
  it('flags a credential-named Zod string with no declaration, at any nesting', () => {
    expect(
      scan(`
        const s = z.object({
          host: z.string(),
          password: z.string().default(''),
          connection: z.object({ apiKey: z.string().describe('k') }),
          localKey: z.preprocess((v) => v, z.string()),
        })`),
    ).toEqual(expect.arrayContaining(['password', 'apiKey', 'localKey']))
    expect(scan('const s = z.object({ host: z.string() })')).toEqual([])
  })

  it('passes a field declared with .meta({ secret: true }) wherever it sits in the chain', () => {
    expect(
      scan(`
        const s = z.object({
          password: z.string().meta({ secret: true }).default(''),
          apiKey: z.string().default('').describe('k').meta({ secret: true }),
        })`),
    ).toEqual([])
  })

  it('ignores non-string values — a numeric maxTokens or a token list is not a credential', () => {
    expect(
      scan(`
        const s = z.object({
          maxTokens: z.number(),
          eventTypeTokens: z.array(z.string()),
          tokenizer: z.enum(['a', 'b']),
        })`),
    ).toEqual([])
  })

  it('flags a text config-UI field named like a credential unless it says secret: true', () => {
    expect(scan(`const f = { type: 'text', key: 'fixedPin', label: 'PIN' }`)).toEqual(['fixedPin'])
    expect(scan(`const f = { type: 'text', key: 'fixedPin', secret: true }`)).toEqual([])
    expect(scan(`const f = { type: 'password', key: 'apiToken' }`)).toEqual([])
  })

  it('an allowlist entry that no longer matches is stale — the list only shrinks', () => {
    const result = evaluate([], new Map([['gone.ts#password', 'was fixed']]))
    expect(result.stale).toEqual(['gone.ts#password'])
  })
})

describe('the real tree', () => {
  // Full-repo scan: ~3 s idle, can exceed the global 10 s vitest budget under
  // CI load (run 37999722088). Same bound as check-no-client-secrets.
  itRealTree(
    'declares every credential-named config field, or pins it with a reason',
    () => {
      const { undeclared, stale } = evaluate(scanRepo(resolve(import.meta.dirname, '../..')))
      expect(undeclared.map((f) => `${f.file}#${f.key}`)).toEqual([])
      expect(stale).toEqual([])
    },
    60_000,
  )

  it('every allowlist entry carries a reason', () => {
    for (const [id, reason] of ALLOWLIST) expect(reason.length, id).toBeGreaterThan(10)
  })
})
