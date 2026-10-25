/**
 * Agent-local addon alignment report.
 *
 * The load-bearing claims:
 *   - "update available" is TRUE only when a published version is strictly
 *     newer than the installed one — a node running a hub-deployed build that
 *     is AHEAD of npm must never be told it is behind,
 *   - an unresolvable published version is UNKNOWN, never "up to date",
 *   - a registry nobody could reach is reported as such, not as a clean list.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstalledAddonPackage, PublishedAddonVersion } from '../agent-addon-updates.js'
import {
  buildAddonUpdateEntries,
  buildAgentAddonUpdateReport,
  readInstalledAddonPackages,
  resolvePublishedVersion,
} from '../agent-addon-updates.js'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function makeAddonsDir(packages: ReadonlyArray<{ dir: string; name: string; version?: string }>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-addon-updates-'))
  tmpDirs.push(root)
  for (const pkg of packages) {
    const full = path.join(root, pkg.dir)
    fs.mkdirSync(full, { recursive: true })
    fs.writeFileSync(
      path.join(full, 'package.json'),
      JSON.stringify({ name: pkg.name, ...(pkg.version ? { version: pkg.version } : {}) }),
    )
  }
  return root
}

function published(
  entries: ReadonlyArray<[string, PublishedAddonVersion]>,
): ReadonlyMap<string, PublishedAddonVersion> {
  return new Map(entries)
}

describe('buildAddonUpdateEntries', () => {
  const installed: readonly InstalledAddonPackage[] = [
    { packageName: '@camstack/addon-pipeline', installedVersion: '1.0.4' },
  ]

  it('flags a package whose published version is strictly newer', () => {
    const [entry] = buildAddonUpdateEntries(
      installed,
      published([['@camstack/addon-pipeline', { latestVersion: '1.0.9', error: null }]]),
    )
    expect(entry?.updateAvailable).toBe(true)
    expect(entry?.latestVersion).toBe('1.0.9')
    expect(entry?.error).toBeNull()
  })

  it('does not flag an identical version', () => {
    const [entry] = buildAddonUpdateEntries(
      installed,
      published([['@camstack/addon-pipeline', { latestVersion: '1.0.4', error: null }]]),
    )
    expect(entry?.updateAvailable).toBe(false)
  })

  it('does not flag a node running a build AHEAD of npm (a hub deploy)', () => {
    // `camstack deploy` ships versions that were never published. Telling the
    // operator such a node is "behind" would invite a downgrade.
    const [entry] = buildAddonUpdateEntries(
      installed,
      published([['@camstack/addon-pipeline', { latestVersion: '1.0.2', error: null }]]),
    )
    expect(entry?.updateAvailable).toBe(false)
  })

  it('treats an unresolvable published version as unknown, not up-to-date', () => {
    const [entry] = buildAddonUpdateEntries(
      installed,
      published([
        ['@camstack/addon-pipeline', { latestVersion: null, error: 'registry GET → 404' }],
      ]),
    )
    expect(entry?.updateAvailable).toBe(false)
    expect(entry?.latestVersion).toBeNull()
    expect(entry?.error).toBe('registry GET → 404')
  })

  it('carries a null installed version through without claiming an update', () => {
    const [entry] = buildAddonUpdateEntries(
      [{ packageName: '@camstack/addon-x', installedVersion: null }],
      published([['@camstack/addon-x', { latestVersion: '2.0.0', error: null }]]),
    )
    expect(entry?.updateAvailable).toBe(false)
  })
})

describe('readInstalledAddonPackages', () => {
  it('reads scoped package dirs by their npm package name, sorted', () => {
    const root = makeAddonsDir([
      { dir: '@camstack/addon-pipeline', name: '@camstack/addon-pipeline', version: '1.0.4' },
      { dir: '@camstack/system', name: '@camstack/system', version: '1.2.61' },
    ])
    expect(readInstalledAddonPackages(root)).toEqual([
      { packageName: '@camstack/addon-pipeline', installedVersion: '1.0.4' },
      // Included on purpose: on an agent this is the ONLY copy of the builtin
      // infra, so it is exactly what a misaligned node must be able to see.
      { packageName: '@camstack/system', installedVersion: '1.2.61' },
    ])
  })

  it('skips a package dir with an unreadable package.json instead of throwing', () => {
    const root = makeAddonsDir([{ dir: 'ok', name: 'ok', version: '1.0.0' }])
    const broken = path.join(root, 'broken')
    fs.mkdirSync(broken)
    fs.writeFileSync(path.join(broken, 'package.json'), '{ not json')
    expect(readInstalledAddonPackages(root)).toEqual([
      { packageName: 'ok', installedVersion: '1.0.0' },
    ])
  })
})

describe('resolvePublishedVersion', () => {
  it('returns dist-tags.latest', async () => {
    const result = await resolvePublishedVersion(
      '@camstack/x',
      'https://reg.test/',
      async (url) => {
        expect(url).toBe('https://reg.test/@camstack%2Fx')
        return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '3.1.0' } }) }
      },
    )
    expect(result).toEqual({ latestVersion: '3.1.0', error: null })
  })

  it('never throws — a network failure becomes an error field', async () => {
    const result = await resolvePublishedVersion('x', 'https://reg.test', async () => {
      throw new Error('ENOTFOUND reg.test')
    })
    expect(result.latestVersion).toBeNull()
    expect(result.error).toBe('ENOTFOUND reg.test')
  })

  it('reports a non-ok status', async () => {
    const result = await resolvePublishedVersion('x', 'https://reg.test', async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }))
    expect(result.error).toBe('registry GET → 404')
  })
})

describe('buildAgentAddonUpdateReport', () => {
  it('reports a registry nobody could reach — not a clean, reassuring list', async () => {
    const root = makeAddonsDir([
      { dir: 'a', name: 'a', version: '1.0.0' },
      { dir: 'b', name: 'b', version: '1.0.0' },
    ])
    const report = await buildAgentAddonUpdateReport({
      addonsDir: root,
      registryUrl: 'https://reg.test',
      fetchFn: async () => {
        throw new Error('offline')
      },
      isHubReachable: () => false,
      now: () => 1234,
    })
    expect(report.error).toContain('Could not reach https://reg.test')
    expect(report.entries.every((e) => e.updateAvailable === false)).toBe(true)
    expect(report.checkedAtMs).toBe(1234)
    expect(report.hubReachable).toBe(false)
  })

  it('keeps a single package failure local to its row', async () => {
    const root = makeAddonsDir([
      { dir: 'a', name: 'a', version: '1.0.0' },
      { dir: 'b', name: 'b', version: '1.0.0' },
    ])
    const report = await buildAgentAddonUpdateReport({
      addonsDir: root,
      registryUrl: 'https://reg.test',
      fetchFn: async (url) =>
        url.endsWith('/a')
          ? { ok: false, status: 404, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '2.0.0' } }) },
      isHubReachable: () => true,
    })
    expect(report.error).toBeNull()
    const a = report.entries.find((e) => e.packageName === 'a')
    const b = report.entries.find((e) => e.packageName === 'b')
    expect(a?.error).toBe('registry GET → 404')
    expect(a?.updateAvailable).toBe(false)
    expect(b?.updateAvailable).toBe(true)
    expect(report.hubReachable).toBe(true)
  })
})
