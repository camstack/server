import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type ContractSource,
  contractCompatProblems,
  contractCoverageProblems,
  contractOf,
} from '../lib/migration-api-contract.js'

const pin = (m: Record<string, ContractSource>) => contractOf(1, m)

const base: Record<string, ContractSource> = {
  'rows.read': {
    input: z.object({ id: z.string(), mode: z.enum(['a', 'b']), note: z.string().optional() }),
    output: z.object({ rows: z.number(), kind: z.enum(['x', 'y']) }),
    behaviours: ['rows.read.returns-rows'],
  },
}

const withInput = (input: z.ZodType): Record<string, ContractSource> => ({
  'rows.read': { ...base['rows.read']!, input },
})
const withOutput = (output: z.ZodType): Record<string, ContractSource> => ({
  'rows.read': { ...base['rows.read']!, output },
})

describe('check-migration-api-append-only', () => {
  it('accepts an identical contract and an additive one', () => {
    expect(contractCompatProblems(pin(base), pin(base))).toEqual([])
    const grown = {
      ...withInput(
        z.object({
          id: z.string(),
          mode: z.enum(['a', 'b', 'c']),
          note: z.string().optional(),
          extra: z.string().optional(),
        }),
      ),
      'rows.extra': base['rows.read']!,
    }
    expect(contractCompatProblems(pin(base), pin(grown))).toEqual([])
  })

  it('fails on a missing method', () => {
    expect(contractCompatProblems(pin(base), pin({}))).toEqual(['rows.read: the method is missing'])
  })

  it('fails on a removed input field and a removed output field', () => {
    const noMode = withInput(z.object({ id: z.string(), note: z.string().optional() }))
    expect(contractCompatProblems(pin(base), pin(noMode))).toContain(
      'rows.read: input field "mode" was removed',
    )
    const noKind = withOutput(z.object({ rows: z.number() }))
    expect(contractCompatProblems(pin(base), pin(noKind))).toContain(
      'rows.read: output field "kind" was removed',
    )
  })

  it('fails on an input field that turned required, and on a new required one', () => {
    const required = withInput(
      z.object({ id: z.string(), mode: z.enum(['a', 'b']), note: z.string() }),
    )
    expect(contractCompatProblems(pin(base), pin(required))).toContain(
      'rows.read: input field "note" turned required',
    )
    const added = withInput(
      z.object({
        id: z.string(),
        mode: z.enum(['a', 'b']),
        note: z.string().optional(),
        more: z.number(),
      }),
    )
    expect(contractCompatProblems(pin(base), pin(added))).toContain(
      'rows.read: new input field "more" is required',
    )
  })

  it('fails on a narrowed enum', () => {
    const narrowed = withInput(
      z.object({ id: z.string(), mode: z.enum(['a']), note: z.string().optional() }),
    )
    expect(contractCompatProblems(pin(base), pin(narrowed))).toContain(
      'rows.read: input field "mode" no longer admits b',
    )
  })

  it('fails on a behaviour id with no it() in the contract spec', () => {
    const current = pin(base)
    expect(contractCoverageProblems(current, "it('something.else', () => {})")).toEqual([
      'rows.read: behaviour "rows.read.returns-rows" has no it(\'rows.read.returns-rows\' in the contract spec',
    ])
    expect(
      contractCoverageProblems(current, "it('rows.read.returns-rows', async () => {})"),
    ).toEqual([])
  })

  it('fails on a removed behaviour', () => {
    const lost = pin({ 'rows.read': { ...base['rows.read']!, behaviours: [] } })
    expect(contractCompatProblems(pin(base), lost)).toContain(
      'rows.read: behaviour "rows.read.returns-rows" was removed',
    )
  })
})
