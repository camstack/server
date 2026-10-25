/**
 * The degradation guard's report must name the procedure, not a count.
 *
 * Fixtures are trimmed from the real expansion produced on 2026-08-15 with
 * `packages/types/dist` + `packages/system/dist` absent — the exact six the
 * guard reported as "output: any → 6".
 */
import { describe, it, expect } from 'vitest'
import { findDegradedProcedures } from '../core-router-degradation.ts'

const proc = (name: string, kind: string, input: string, output: string): string =>
  `    ${name}: import("@trpc/server").TRPC${kind}Procedure<{        input: ${input};        output: ${output};        meta: object;    }>;`

describe('findDegradedProcedures', () => {
  it('returns nothing for a fully typed expansion', () => {
    const texts = new Map([['auth', proc('logout', 'Mutation', 'void', '{ success: true; }')]])
    expect(findDegradedProcedures(texts)).toEqual([])
  })

  it('names the router and method that lost its output type', () => {
    const texts = new Map([
      [
        'capabilities',
        proc('listCapabilities', 'Query', 'void', 'any') +
          proc('getDeviceCapabilities', 'Query', '{ deviceId: string; }', 'Record<string, string>'),
      ],
    ])
    expect(findDegradedProcedures(texts)).toEqual([
      { router: 'capabilities', method: 'listCapabilities', field: 'output' },
    ])
  })

  it('attributes an `any[]` output to its own procedure, not the previous one', () => {
    const texts = new Map([
      [
        'auth',
        proc(
          'finishOwnPasskeyRegistration',
          'Mutation',
          '{ label: string; }',
          '{ success: true; }',
        ) + proc('listOwnPasskeys', 'Query', 'void', 'any[]'),
      ],
    ])
    expect(findDegradedProcedures(texts)).toEqual([
      { router: 'auth', method: 'listOwnPasskeys', field: 'output' },
    ])
  })

  it('reports a degraded input as well as a degraded output', () => {
    const texts = new Map([['live', proc('start', 'Mutation', 'any', 'any')]])
    expect(findDegradedProcedures(texts)).toEqual([
      { router: 'live', method: 'start', field: 'input' },
      { router: 'live', method: 'start', field: 'output' },
    ])
  })

  it('reports a repeated procedure once — a router type is an intersection', () => {
    // The real `capabilities` expansion contains the same object twice
    // (`A & B`), which is why the count was 6 for 3 distinct procedures.
    const body = proc('listCapabilities', 'Query', 'void', 'any')
    const texts = new Map([['capabilities', `${body} & ${body}`]])
    expect(findDegradedProcedures(texts)).toEqual([
      { router: 'capabilities', method: 'listCapabilities', field: 'output' },
    ])
  })

  it('covers every router in the map', () => {
    const texts = new Map([
      ['capabilities', proc('getCapability', 'Query', '{ name: string; }', 'any')],
      ['auth', proc('listOwnPasskeys', 'Query', 'void', 'any[]')],
    ])
    expect(findDegradedProcedures(texts).map((d) => `${d.router}.${d.method}`)).toEqual([
      'capabilities.getCapability',
      'auth.listOwnPasskeys',
    ])
  })
})
