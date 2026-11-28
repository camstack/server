import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  HEAVY_WEIGHT_SECONDS,
  laneHeapMb,
  laneProcessCount,
  localLaneBudget,
  localLanesEnabled,
  nodeOptionsWithHeap,
  lanePlan,
  orderLongestFirst,
  orderProjects,
} from '../ci/lane-budget.mjs'
import { workspacePackageDirs } from '../ci/run-test-lanes.mjs'

interface LaneBudget {
  readonly concurrent: boolean
  readonly heavyParallel: number
  readonly lightParallel: number
  readonly heavyWorkers: number
  readonly lightWorkers: number
}

function slots(budget: LaneBudget): number {
  return budget.heavyParallel * budget.heavyWorkers + budget.lightParallel * budget.lightWorkers
}

describe('local lane budget', () => {
  it('splits a 12-core machine into heavy 2×4 and light 2×2', () => {
    expect(localLaneBudget({ cpus: 12, heavyCount: 8, lightCount: 30, env: {} })).toEqual({
      concurrent: true,
      heavyParallel: 2,
      lightParallel: 2,
      heavyWorkers: 4,
      lightWorkers: 2,
    })
  })

  it('never schedules more vitest workers than cores', () => {
    for (const cpus of [1, 2, 4, 6, 8, 12, 16]) {
      const budget = localLaneBudget({
        cpus,
        heavyCount: 8,
        lightCount: 30,
        env: {},
      })
      // A serial schedule (one core cannot host both lanes) pays one lane at a time.
      const atOnce = budget.concurrent
        ? slots(budget)
        : Math.max(
            budget.heavyParallel * budget.heavyWorkers,
            budget.lightParallel * budget.lightWorkers,
          )
      expect(atOnce).toBeLessThanOrEqual(cpus)
      expect(budget.heavyParallel).toBeGreaterThanOrEqual(1)
      expect(budget.lightParallel).toBeGreaterThanOrEqual(1)
      expect(budget.heavyWorkers).toBeGreaterThanOrEqual(1)
      expect(budget.lightWorkers).toBeGreaterThanOrEqual(1)
    }
  })

  it('shrinks workers when a caller asks for more light slots than the cores can feed', () => {
    expect(
      localLaneBudget({
        cpus: 12,
        heavyCount: 8,
        lightCount: 30,
        env: { LIGHT_PARALLEL: '3' },
      }),
    ).toEqual({
      concurrent: true,
      heavyParallel: 2,
      lightParallel: 3,
      heavyWorkers: 3,
      lightWorkers: 2,
    })
  })

  it('runs the lanes one after the other on a single core', () => {
    const budget = localLaneBudget({
      cpus: 1,
      heavyCount: 8,
      lightCount: 4,
      env: {},
    })
    expect(budget.concurrent).toBe(false)
    expect(budget.heavyParallel * budget.heavyWorkers).toBeLessThanOrEqual(1)
    expect(budget.lightParallel * budget.lightWorkers).toBeLessThanOrEqual(1)
  })

  it('lets the light lane fill the machine when nothing heavy is selected', () => {
    expect(localLaneBudget({ cpus: 12, heavyCount: 0, lightCount: 10, env: {} })).toEqual({
      concurrent: false,
      heavyParallel: 0,
      heavyWorkers: 0,
      lightParallel: 3,
      lightWorkers: 4,
    })
  })

  it('honours VERIFY_HEAVY_PARALLEL', () => {
    const budget = localLaneBudget({
      cpus: 12,
      heavyCount: 8,
      lightCount: 10,
      env: { VERIFY_HEAVY_PARALLEL: '1' },
    })
    expect(budget.heavyParallel).toBe(1)
    expect(slots(budget)).toBeLessThanOrEqual(12)
  })
})

describe('lane heap', () => {
  it('fits the 12-core split in a 36 GB machine instead of inheriting a 3 GB heap per process', () => {
    const budget = localLaneBudget({
      cpus: 12,
      heavyCount: 8,
      lightCount: 30,
      env: {},
    })
    const processes = laneProcessCount(budget)
    expect(processes).toBe(16)
    const heap = laneHeapMb({
      totalBytes: 36 * 1024 * 1024 * 1024,
      processCount: processes,
    })
    expect(heap).toBe(1792)
    expect(nodeOptionsWithHeap('--max-old-space-size=3072', heap)).toBe('--max-old-space-size=1792')
  })
})

describe('package directories', () => {
  it('resolves the sdk nx project to its directory — the npm workspace name is different', () => {
    const dirs = workspacePackageDirs()
    expect(dirs.get('sdk')).toBe('packages/sdk')
    expect(dirs.get('@dominevo/server-framework')).toBe('packages/system')
    expect(dirs.get('@dominevo/e2e')).toBe('e2e')
  })
})

describe('local lane switch', () => {
  it('is on outside CI and off when CI is set', () => {
    expect(localLanesEnabled({})).toBe(true)
    expect(localLanesEnabled({ CI: 'true' })).toBe(false)
    expect(localLanesEnabled({ CI: 'true', VERIFY_LOCAL: '1' })).toBe(true)
    expect(localLanesEnabled({ VERIFY_LOCAL: '0' })).toBe(false)
    expect(localLanesEnabled({ CI: 'false' })).toBe(true)
  })

  it('exits 0 from the CLI only when the local lanes are on', () => {
    const enabled = execFileSync('node', ['scripts/ci/lane-budget.mjs', '--enabled'], {
      encoding: 'utf8',
      env: { ...process.env, CI: '', VERIFY_LOCAL: '' },
    })
    expect(enabled).toBe('')
    expect(cliStatus({ CI: 'true', VERIFY_LOCAL: '' })).toBe(1)
  })
})

describe('local lane runner plan', () => {
  it('orders the heavy list and prints the 12-core split', () => {
    const out = execFileSync(
      'node',
      [
        'scripts/ci/run-test-lanes.mjs',
        '--print-plan',
        '--cpus',
        '12',
        '--heavy',
        '@dominevo/ui-library,@dominevo/addon-admin-ui',
        '--light',
        '@dominevo/addon-ai,@dominevo/addon-training',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CI: '',
          LIGHT_PARALLEL: '',
          VERIFY_LIGHT_PARALLEL: '',
          VERIFY_HEAVY_PARALLEL: '',
          VERIFY_HEAVY_WORKERS: '',
          VERIFY_LIGHT_WORKERS: '',
          VERIFY_VITEST_MAX_WORKERS: '',
          VITEST_MAX_WORKERS: '',
        },
      },
    )
    expect(JSON.parse(out)).toMatchObject({
      concurrent: true,
      heavyParallel: 2,
      heavyWorkers: 4,
      lightParallel: 2,
      lightWorkers: 2,
      heavy: ['@dominevo/addon-admin-ui', '@dominevo/ui-library'],
    })
  })

  it('keeps the CI heavy lane on one nx process at parallel 1', () => {
    const src = readFileSync('scripts/ci/test-affected.sh', 'utf8')
    expect(src).toContain(
      'npx nx run-many -t test --projects="${HEAVY_CSV}" --parallel=1 --output-style stream',
    )
    expect(src).toContain('lane-budget.mjs --enabled')
  })
})

function cliStatus(env: Readonly<Record<string, string>>): number {
  try {
    execFileSync('node', ['scripts/ci/lane-budget.mjs', '--enabled'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return 0
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof error.status === 'number'
    ) {
      return error.status
    }
    throw error
  }
}

describe('heavy project order', () => {
  it('starts the longest measured projects first and puts an unknown project ahead of them', () => {
    expect(
      orderLongestFirst([
        '@dominevo/ui-library',
        '@dominevo/addon-pipeline',
        '@dominevo/addon-admin-ui',
        '@dominevo/brand-new',
      ]),
    ).toEqual([
      '@dominevo/brand-new',
      '@dominevo/addon-admin-ui',
      '@dominevo/ui-library',
      '@dominevo/addon-pipeline',
    ])
    expect(HEAVY_WEIGHT_SECONDS['@dominevo/addon-admin-ui']).toBeGreaterThan(
      HEAVY_WEIGHT_SECONDS['@dominevo/ui-library'],
    )
  })
})

describe('projects that failed last time', () => {
  it('start first, longest first among themselves, then the rest longest first', () => {
    expect(
      orderProjects(
        [
          '@dominevo/addon-admin-ui',
          '@dominevo/server',
          '@dominevo/types',
          '@dominevo/addon-pipeline',
        ],
        ['@dominevo/types', '@dominevo/addon-pipeline'],
      ),
    ).toEqual([
      '@dominevo/addon-pipeline',
      '@dominevo/types',
      '@dominevo/addon-admin-ui',
      '@dominevo/server',
    ])
  })

  it('a plan puts a previously failed light project at the front of its lane', () => {
    const plan = lanePlan({
      cpus: 12,
      heavy: ['@dominevo/server'],
      light: ['a', 'b', 'c'],
      failedBefore: ['c'],
    })
    expect(plan.light).toEqual(['c', 'a', 'b'])
  })

  it('with no history the order is the plain longest-first one', () => {
    const heavy = ['@dominevo/ui-library', '@dominevo/addon-admin-ui']
    expect(orderProjects(heavy)).toEqual(orderLongestFirst(heavy))
  })
})
