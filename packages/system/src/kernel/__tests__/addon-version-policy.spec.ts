/**
 * D942 — an installed addon follows registry `latest` in either direction,
 * and an unreadable registry is not a version.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { AddonInstaller } from '../addon-installer.js'
import { clearHeldInstall, listHeldInstalls } from '../held-installs.js'
import { RegistryReadError } from '../requires-registry.js'
import {
  ADDON_VERSION_REASON_HUB,
  ADDON_VERSION_REASON_REGISTRY_LATEST,
  decideAddonVersionMove,
} from '../addon-version-policy.js'

describe('decideAddonVersionMove', () => {
  it('moves up and down, and stays when the target cannot be read or already matches', () => {
    expect(decideAddonVersionMove('1.2.6', '1.2.7', ADDON_VERSION_REASON_REGISTRY_LATEST)).toEqual({
      move: true,
      from: '1.2.6',
      to: '1.2.7',
      reason: ADDON_VERSION_REASON_REGISTRY_LATEST,
    })
    expect(decideAddonVersionMove('1.2.7', '1.2.6', ADDON_VERSION_REASON_REGISTRY_LATEST)).toEqual({
      move: true,
      from: '1.2.7',
      to: '1.2.6',
      reason: ADDON_VERSION_REASON_REGISTRY_LATEST,
    })
    expect(decideAddonVersionMove('1.2.6', '1.2.6', ADDON_VERSION_REASON_REGISTRY_LATEST)).toEqual({
      move: false,
    })
    expect(decideAddonVersionMove('1.2.7', null, ADDON_VERSION_REASON_REGISTRY_LATEST)).toEqual({
      move: false,
    })
    expect(decideAddonVersionMove('1.2.7', '', ADDON_VERSION_REASON_HUB)).toEqual({ move: false })
    expect(decideAddonVersionMove(null, '1.2.6', ADDON_VERSION_REASON_HUB)).toEqual({
      move: true,
      from: 'absent',
      to: '1.2.6',
      reason: ADDON_VERSION_REASON_HUB,
    })
  })
})

describe('decideAddonVersionMove with unmet requirements (D989)', () => {
  const unmet = [{ kind: 'server-too-old', required: '1.3.0', running: '1.2.0' }] as const

  it('holds a move whose target needs a newer server and names why', () => {
    expect(
      decideAddonVersionMove('1.2.6', '1.2.7', ADDON_VERSION_REASON_REGISTRY_LATEST, unmet),
    ).toEqual({ move: false, blockedBy: unmet })
  })

  it('holds a first install the same way', () => {
    expect(decideAddonVersionMove(null, '1.2.7', ADDON_VERSION_REASON_HUB, unmet)).toEqual({
      move: false,
      blockedBy: unmet,
    })
  })

  it('has nothing to hold when there is no move', () => {
    expect(
      decideAddonVersionMove('1.2.7', '1.2.7', ADDON_VERSION_REASON_REGISTRY_LATEST, unmet),
    ).toEqual({ move: false })
  })

  it('moves when nothing is unmet', () => {
    expect(
      decideAddonVersionMove('1.2.6', '1.2.7', ADDON_VERSION_REASON_REGISTRY_LATEST, []),
    ).toMatchObject({ move: true, to: '1.2.7' })
  })
})

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function capturingLogger(): {
  readonly logger: IScopedLogger
  readonly lines: string[]
} {
  const lines: string[] = []
  const logger: IScopedLogger = {
    debug() {},
    info(message: string, extras?: LogExtras) {
      const from = extras?.meta?.['from']
      const to = extras?.meta?.['to']
      lines.push(`${message} ${String(from)} ${String(to)} ${String(extras?.meta?.['reason'])}`)
    },
    warn(message: string) {
      lines.push(message)
    },
    error() {},
    child() {
      return logger
    },
    withTags() {
      return logger
    },
  }
  return { logger, lines }
}

function installed(root: string, name: string, version: string): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }))
}

describe('ensureRequiredPackages follows registry latest', () => {
  it('moves an installed addon down to a lower latest and logs from, to and the reason', async () => {
    const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-latest-'))
    tmpDirs.push(addonsDir)
    installed(addonsDir, '@camstack/addon-pipeline', '1.2.7')
    const { logger, lines } = capturingLogger()
    const installer = new AddonInstaller(
      {
        addonsDir,
        resolveLatestVersion: async () => '1.2.6',
      },
      logger,
    )
    const apply = vi.spyOn(installer, 'applyUpdate').mockResolvedValue({
      name: '@camstack/addon-pipeline',
      version: '1.2.6',
      backupDir: '/bak',
    })

    await installer.ensureRequiredPackages(['@camstack/addon-pipeline'])

    expect(apply).toHaveBeenCalledWith('@camstack/addon-pipeline', '1.2.6')
    expect(lines.some((line) => line.includes('1.2.7') && line.includes('1.2.6'))).toBe(true)
    expect(
      lines.some((line) => line.includes('installed version differs from registry latest')),
    ).toBe(true)
  })

  it('installs nothing when the registry cannot be read', async () => {
    const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-latest-'))
    tmpDirs.push(addonsDir)
    installed(addonsDir, '@camstack/addon-pipeline', '1.2.7')
    const installer = new AddonInstaller({
      addonsDir,
      resolveLatestVersion: async () => {
        throw new Error('ENOTFOUND registry.npmjs.org')
      },
    })
    const apply = vi.spyOn(installer, 'applyUpdate')

    await installer.ensureRequiredPackages(['@camstack/addon-pipeline'])

    expect(apply).not.toHaveBeenCalled()
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(addonsDir, '@camstack/addon-pipeline', 'package.json'), 'utf-8'),
    )
    expect(raw).toEqual({ name: '@camstack/addon-pipeline', version: '1.2.7' })
  })

  it('leaves a copy that already matches latest', async () => {
    const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-latest-'))
    tmpDirs.push(addonsDir)
    installed(addonsDir, '@camstack/addon-pipeline', '1.2.6')
    const installer = new AddonInstaller({
      addonsDir,
      resolveLatestVersion: async () => '1.2.6',
    })
    const apply = vi.spyOn(installer, 'applyUpdate')
    await installer.ensureRequiredPackages(['@camstack/addon-pipeline'])
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('ensureRequiredPackages holds a version the running server cannot host (D989, planning#447)', () => {
  const needsNewer = async () => ({ server: '>=9.0.0' as const })

  it('does not install a first-boot addon whose latest needs a newer server, and names both versions', async () => {
    const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-requires-'))
    tmpDirs.push(addonsDir)
    const { logger, lines } = capturingLogger()
    const installer = new AddonInstaller(
      { addonsDir, serverVersion: '1.2.0', resolveRequires: needsNewer },
      logger,
    )
    const install = vi.spyOn(installer, 'installFromNpm')

    await installer.ensureRequiredPackages(['@camstack/addon-pipeline'])

    expect(install).not.toHaveBeenCalled()
    expect(lines.some((l) => l.includes('9.0.0') && l.includes('1.2.0'))).toBe(true)
  })

  it('holds the install when the requirements cannot be read', async () => {
    const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-requires-'))
    tmpDirs.push(addonsDir)
    const installer = new AddonInstaller({
      addonsDir,
      serverVersion: '1.2.0',
      resolveRequires: async () => {
        throw new Error('the registry answered 503')
      },
    })
    const install = vi.spyOn(installer, 'installFromNpm')
    await installer.ensureRequiredPackages(['@camstack/addon-pipeline'])
    expect(install).not.toHaveBeenCalled()
  })

  it('installs when the server meets the minimum', async () => {
    const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-requires-'))
    tmpDirs.push(addonsDir)
    const installer = new AddonInstaller({
      addonsDir,
      serverVersion: '9.0.1',
      resolveRequires: needsNewer,
    })
    const install = vi.spyOn(installer, 'installFromNpm').mockResolvedValue({
      name: '@camstack/addon-pipeline',
      version: '1.0.0',
    })
    await installer.ensureRequiredPackages(['@camstack/addon-pipeline'])
    expect(install).toHaveBeenCalledWith('@camstack/addon-pipeline')
  })

  it('does not move an installed copy to a latest that needs a newer server', async () => {
    const addonsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-requires-'))
    tmpDirs.push(addonsDir)
    installed(addonsDir, '@camstack/addon-pipeline', '1.2.7')
    const installer = new AddonInstaller({
      addonsDir,
      serverVersion: '1.2.0',
      resolveLatestVersion: async () => '1.3.0',
      resolveRequires: needsNewer,
    })
    const apply = vi.spyOn(installer, 'applyUpdate')
    await installer.ensureRequiredPackages(['@camstack/addon-pipeline'])
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('first boot falls back to the newest version this server can host (planning#447)', () => {
  type Minimum = `>=${string}`
  const requiresOfVersion =
    (table: Readonly<Record<string, Minimum>>) => async (_name: string, spec: string) => {
      const range = table[spec]
      return range === undefined ? undefined : { server: range }
    }
  const dirFor = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-fallback-'))
    tmpDirs.push(dir)
    return dir
  }

  it('installs the newest older version whose requires the server meets, not latest', async () => {
    clearHeldInstall('@camstack/addon-pipeline')
    const installer = new AddonInstaller({
      addonsDir: dirFor(),
      serverVersion: '1.2.0',
      resolveRequires: requiresOfVersion({
        latest: '>=9.0.0',
        '3.0.0': '>=9.0.0',
        '2.0.0': '>=1.2.0',
      }),
      listVersions: async () => ['3.0.0', '2.0.0', '1.0.0'],
    })
    const install = vi.spyOn(installer, 'installFromNpm').mockResolvedValue({
      name: '@camstack/addon-pipeline',
      version: '2.0.0',
    })
    await installer.ensureRequiredPackages(['@camstack/addon-pipeline'])
    expect(install).toHaveBeenCalledWith('@camstack/addon-pipeline', '2.0.0')
    expect(listHeldInstalls()).toEqual([])
  })

  it('holds with a typed reason and records it for the alert when no version fits', async () => {
    clearHeldInstall('@camstack/addon-pipeline')
    const installer = new AddonInstaller({
      addonsDir: dirFor(),
      serverVersion: '1.2.0',
      resolveRequires: async () => ({ server: '>=9.0.0' }),
      listVersions: async () => ['3.0.0', '2.0.0'],
    })
    const install = vi.spyOn(installer, 'installFromNpm')
    await installer.ensureRequiredPackages(['@camstack/addon-pipeline'])
    expect(install).not.toHaveBeenCalled()
    const held = listHeldInstalls()
    expect(held).toHaveLength(1)
    expect(held[0]?.code).toBe('no-compatible-version')
    expect(held[0]?.reason).toContain('1.2.0')
    expect(held[0]?.reason).toContain('9.0.0')
  })

  it('an unreadable running server version passes nothing that declares a minimum, and says unknown', async () => {
    clearHeldInstall('@camstack/addon-pipeline')
    const installer = new AddonInstaller({
      addonsDir: dirFor(),
      serverVersion: null,
      resolveRequires: async () => ({ server: '>=1.0.0' }),
      listVersions: async () => ['3.0.0', '2.0.0'],
    })
    const install = vi.spyOn(installer, 'installFromNpm')
    await installer.ensureRequiredPackages(['@camstack/addon-pipeline'])
    expect(install).not.toHaveBeenCalled()
    const held = listHeldInstalls()
    expect(held).toHaveLength(1)
    expect(held[0]?.reason).toContain('unknown')
    expect(held[0]?.reason).not.toContain('null')
  })

  it('records an auth failure of its own as an unreadable registry, never as an unmet minimum', async () => {
    clearHeldInstall('@camstack/addon-pipeline')
    const installer = new AddonInstaller({
      addonsDir: dirFor(),
      serverVersion: '1.2.0',
      resolveRequires: async () => {
        throw new RegistryReadError('auth', 'npm error code E401')
      },
    })
    const install = vi.spyOn(installer, 'installFromNpm')
    await installer.ensureRequiredPackages(['@camstack/addon-pipeline'])
    expect(install).not.toHaveBeenCalled()
    expect(listHeldInstalls()[0]?.code).toBe('registry-unreadable')
    expect(listHeldInstalls()[0]?.reason).toContain('auth')
  })
})
