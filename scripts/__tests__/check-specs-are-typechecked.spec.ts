/**
 * The guard for specs nothing typechecks. vitest strips types without checking
 * them, and most packages' tsconfig.json excluded the specs — so a fixture
 * could drift arbitrarily far from the types it claims to exercise.
 */
import { describe, expect, it } from 'vitest'

import {
  ambientDeclarationsIn,
  judgeAmbientDeclarations,
  judgeSpecTypecheck,
} from '../check-specs-are-typechecked.js'

const SPECS = ['src/__tests__/a.spec.ts', 'src/b.test.ts'] as const

describe('judgeSpecTypecheck', () => {
  it('passes a package whose typecheck program holds every spec', () => {
    expect(
      judgeSpecTypecheck({
        name: '@x/a',
        specFiles: SPECS,
        hasSpecConfig: true,
        typecheckScript: 'tsc --noEmit -p tsconfig.spec.json',
        programFiles: new Set(['src/index.ts', ...SPECS]),
      }),
    ).toEqual([])
  })

  it('refuses a package with specs and no tsconfig.spec.json', () => {
    expect(
      judgeSpecTypecheck({
        name: '@x/a',
        specFiles: SPECS,
        hasSpecConfig: false,
        typecheckScript: 'tsc --noEmit',
        programFiles: null,
      }),
    ).toEqual(['@x/a: 2 spec file(s) and no `tsconfig.spec.json`'])
  })

  // The exact state of the repo before this guard: the config existed nowhere,
  // and where a package's own tsconfig excluded the specs, `tsc --noEmit` ran
  // that one.
  it('refuses a typecheck script that runs the build config', () => {
    const out = judgeSpecTypecheck({
      name: '@x/a',
      specFiles: SPECS,
      hasSpecConfig: true,
      typecheckScript: 'tsc --noEmit',
      programFiles: new Set(SPECS),
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/does not run `tsconfig.spec.json`/)
  })

  it('refuses a spec config whose program misses a spec', () => {
    const out = judgeSpecTypecheck({
      name: '@x/a',
      specFiles: SPECS,
      hasSpecConfig: true,
      typecheckScript: 'tsc --noEmit -p tsconfig.spec.json',
      programFiles: new Set(['src/b.test.ts']),
    })
    expect(out).toEqual([
      '@x/a: 1 spec file(s) outside `tsconfig.spec.json` — e.g. src/__tests__/a.spec.ts',
    ])
  })

  it('says nothing about a package with no specs', () => {
    expect(
      judgeSpecTypecheck({
        name: '@x/a',
        specFiles: [],
        hasSpecConfig: false,
        typecheckScript: undefined,
        programFiles: null,
      }),
    ).toEqual([])
  })
})

// The review's bypass probe: each of these kept the guard GREEN before.
describe('the spec config may not weaken the production check it now owns', () => {
  const base = {
    name: '@x/a',
    specFiles: SPECS,
    hasSpecConfig: true,
    programFiles: new Set(SPECS),
    specConfigExtends: './tsconfig.json',
  } as const

  it('refuses a typecheck script that cannot fail', () => {
    const out = judgeSpecTypecheck({
      ...base,
      typecheckScript: 'tsc --noEmit -p tsconfig.spec.json || true',
      specConfigOptions: {},
    })
    expect(out).toHaveLength(1)
  })

  it('accepts a second program after the spec program', () => {
    expect(
      judgeSpecTypecheck({
        ...base,
        typecheckScript:
          'tsc --noEmit -p tsconfig.spec.json && tsc --noEmit -p tsconfig.server.json',
        specConfigOptions: {},
      }),
    ).toEqual([])
  })

  it('refuses noCheck / strict:false in the spec config', () => {
    for (const opts of [{ noCheck: true }, { strict: false }, { rootDir: '../..' }]) {
      const out = judgeSpecTypecheck({
        ...base,
        typecheckScript: 'tsc --noEmit -p tsconfig.spec.json',
        specConfigOptions: opts,
      })
      expect(out, JSON.stringify(opts)).toHaveLength(1)
    }
  })

  it('accepts exactly the override a package is allowlisted for', () => {
    expect(
      judgeSpecTypecheck({
        ...base,
        name: '@camstack/addon-pipeline',
        typecheckScript: 'tsc --noEmit -p tsconfig.spec.json',
        specConfigOptions: { rootDir: '../..' },
      }),
    ).toEqual([])
  })

  it('refuses a spec config that extends something else', () => {
    const out = judgeSpecTypecheck({
      ...base,
      specConfigExtends: '../../tsconfig.base.json',
      typecheckScript: 'tsc --noEmit -p tsconfig.spec.json',
      specConfigOptions: {},
    })
    expect(out).toHaveLength(1)
  })
})

describe('ambient declarations in test files', () => {
  it('finds reference types, declare module and declare global', () => {
    const src = [
      '/// <reference types="@testing-library/jest-dom" />',
      "declare module 'vitest' {",
      "declare module '@camstack/types'",
      'declare global {',
    ].join('\n')
    expect(ambientDeclarationsIn('a.spec.ts', src).map((d) => `${d.kind}:${d.target}`)).toEqual([
      'reference-types:@testing-library/jest-dom',
      'module:vitest',
      'module:@camstack/types',
      'global:',
    ])
  })

  it('allows matcher typing, refuses a module override and a global', () => {
    const decls = ambientDeclarationsIn(
      'a.spec.ts',
      "/// <reference types=\"@testing-library/jest-dom\" />\ndeclare module 'vitest' {\ndeclare module '@camstack/types'\ndeclare global {",
    )
    expect(judgeAmbientDeclarations('@x/a', decls, new Set())).toHaveLength(2)
  })

  it('allows the backend shim only while production does not import the module', () => {
    const decls = ambientDeclarationsIn('s.ts', "declare module '@camstack/addon-benchmark'")
    expect(judgeAmbientDeclarations('@camstack/server', decls, new Set())).toEqual([])
    expect(
      judgeAmbientDeclarations('@camstack/server', decls, new Set(['@camstack/addon-benchmark'])),
    ).toHaveLength(1)
  })
})
