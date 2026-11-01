/**
 * D989: the starter declares which servers it can host
 * (`camstack.requires.server`). A staged server outside that range is refused
 * at the swap and `current` stays — the previous server keeps running.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import { rootPackageDir, serverRootDir, validateClosureDir } from '../root-state.js'
import {
  applyPendingRootSwap,
  currentDir,
  readPendingRootSwap,
  stagingDirPath,
  writePendingRootSwap,
} from '../root-single-copy.js'
import { STARTER_HOSTS_SERVER_MIN } from '../starter-core.js'

const NOW = 1_700_000_000_000
let tmp: string
let rootDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-range-'))
  rootDir = serverRootDir(path.join(tmp, 'data'))
  fs.mkdirSync(rootDir, { recursive: true })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function closure(dir: string, version: string): void {
  const pkgDir = rootPackageDir(dir, HUB_ROOT_SPEC)
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// entry')
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@camstack/server', version }),
  )
  for (const rel of [
    'better-sqlite3/build/Release/better_sqlite3.node',
    '@img/sharp-linux-x64/lib/sharp.node',
    '@seydx/node-av-linux-x64/av.node',
  ]) {
    const full = path.join(dir, 'node_modules', ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'ELF')
  }
}

function arm(version: string): string {
  const staging = stagingDirPath(rootDir, version, 1, NOW)
  closure(staging, version)
  writePendingRootSwap(rootDir, {
    schemaVersion: 1,
    version,
    stagingPath: staging,
    requestedAtMs: NOW,
  })
  return staging
}

const swap = (min: string | undefined) =>
  applyPendingRootSwap(
    rootDir,
    HUB_ROOT_SPEC,
    24,
    () => NOW,
    () => {},
    min,
  )

describe('a starter refuses a server outside the range it hosts', () => {
  it('keeps the previous server and discards the staged one', () => {
    closure(currentDir(rootDir), '1.2.700')
    const staging = arm('1.2.600')
    const res = swap('1.2.650')
    expect(res.applied).toBe(false)
    expect(res.reason).toContain('1.2.600')
    expect(res.reason).toContain('1.2.650')
    expect(validateClosureDir(currentDir(rootDir), 24, HUB_ROOT_SPEC, '1.2.700')).toBeNull()
    expect(fs.existsSync(staging)).toBe(false)
    expect(readPendingRootSwap(rootDir)).toBeNull()
  })

  it('swaps a server at the minimum', () => {
    closure(currentDir(rootDir), '1.2.700')
    arm('1.2.650')
    expect(swap('1.2.650')).toMatchObject({ applied: true, version: '1.2.650' })
  })

  it('swaps when the starter declares no range (existing behaviour)', () => {
    arm('0.0.1')
    expect(swap(undefined)).toMatchObject({ applied: true })
  })
})

describe('STARTER_HOSTS_SERVER_MIN', () => {
  it('is the range node-root declares in its package.json', () => {
    const pkg: unknown = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'),
    )
    const requires =
      typeof pkg === 'object' && pkg !== null
        ? (pkg as { camstack?: { requires?: { server?: string } } }).camstack?.requires
        : undefined
    expect(requires?.server).toBe(`>=${STARTER_HOSTS_SERVER_MIN}`)
  })
})
