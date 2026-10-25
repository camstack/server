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

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function capturingLogger(): { readonly logger: IScopedLogger; readonly lines: string[] } {
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
        installSource: 'npm',
        resolveLatestVersion: async () => '1.2.6',
      },
      logger,
    )
    const apply = vi
      .spyOn(installer, 'applyUpdate')
      .mockResolvedValue({ name: '@camstack/addon-pipeline', version: '1.2.6', backupDir: '/bak' })

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
      installSource: 'npm',
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
      installSource: 'npm',
      resolveLatestVersion: async () => '1.2.6',
    })
    const apply = vi.spyOn(installer, 'applyUpdate')
    await installer.ensureRequiredPackages(['@camstack/addon-pipeline'])
    expect(apply).not.toHaveBeenCalled()
  })
})
