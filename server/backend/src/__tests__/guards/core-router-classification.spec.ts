import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_ROUTER_EXPECTATIONS } from './core-router-classification.expectations.js'
import {
  coreRouterFailures,
  countProcedureUsages,
  evaluateCoreRouterGuard,
  mountedCoreRouterKeys,
} from './core-router-classification.guard.js'

const PACKAGE_ROOT = path.resolve(__dirname, '../../..')

const router = (keys: readonly string[]): string =>
  [
    '  return {',
    '    // Non-cap (core) routers',
    ...keys.map((k) => `    ${k}: create${k[0]?.toUpperCase() ?? ''}${k.slice(1)}Router(ctx),`),
    '    // NOT MOUNTED: …',
    '  }',
  ].join('\n')

const ALL_KEYS = CORE_ROUTER_EXPECTATIONS.map((e) => e.key)
const cleanSources = (overrides: Record<string, string> = {}) => ({
  router: router(ALL_KEYS),
  byFile: (rel: string): string | undefined =>
    overrides[rel] ?? 'export const r = adminProcedure.query()\nconst v = scopedEventVisibility\n',
})

describe('core router classification', () => {
  it('the checked-out backend passes', () => {
    expect(evaluateCoreRouterGuard(PACKAGE_ROOT)).toEqual([])
  })

  it('reads the mounted keys between the two markers', () => {
    expect(mountedCoreRouterKeys(router(['logs', 'auth']))).toEqual(['auth', 'logs'])
    expect(() => mountedCoreRouterKeys('nothing here')).toThrow(/marker/)
  })

  it('counts procedure usages outside comments and imports', () => {
    const src = [
      "import { protectedProcedure } from './trpc.js' // protectedProcedure",
      '/** Before 2026-08-13 these were protectedProcedure */',
      'const a = protectedProcedure.query()',
    ].join('\n')
    expect(countProcedureUsages(src, 'protectedProcedure')).toBe(1)
  })

  it('a table that matches the mount passes', () => {
    expect(coreRouterFailures(cleanSources())).toEqual([])
  })

  it('refuses an UNCLASSIFIED mounted router — the surface with no device filtering', () => {
    const out = coreRouterFailures({ ...cleanSources(), router: router([...ALL_KEYS, 'newThing']) })
    expect(out.some((e) => e.includes("UNCLASSIFIED core router 'newThing'"))).toBe(true)
  })

  it('refuses an admin-only router that grew a protectedProcedure, and a stale entry', () => {
    const repl = CORE_ROUTER_EXPECTATIONS.find((e) => e.classification === 'admin-only')
    if (repl === undefined) throw new Error('fixture needs an admin-only entry')
    const out = coreRouterFailures({
      router: router(ALL_KEYS.filter((k) => k !== 'logs')),
      byFile: (rel) =>
        rel === repl.file ? 'const p = protectedProcedure.query()\n' : cleanSources().byFile(rel),
    })
    expect(
      out.some((e) =>
        e.includes(
          `'${repl.key}' is declared 'admin-only' but its source uses protectedProcedure 1×`,
        ),
      ),
    ).toBe(true)
    expect(out.some((e) => e.includes("STALE entry 'logs'"))).toBe(true)
  })

  it('refuses a device-filtered router that never references the visibility filter', () => {
    const df = CORE_ROUTER_EXPECTATIONS.find((e) => e.classification === 'device-filtered')
    if (df === undefined) throw new Error('fixture needs a device-filtered entry')
    const out = coreRouterFailures({
      ...cleanSources(),
      byFile: (rel) =>
        rel === df.file ? 'const p = adminProcedure.query()\n' : cleanSources().byFile(rel),
    })
    expect(out.some((e) => e.includes(`'${df.key}' is declared 'device-filtered'`))).toBe(true)
  })
})
