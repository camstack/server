/**
 * Privileged package broker (D326).
 *
 * The runner is uid 1001 and must never exec apt. These tests pin the
 * allowlist, the refuse-unknown rule, and that `installManifestSystemDeps`
 * talks to the helper for apt instead of spawning apt-get.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AddonDeclaration, IScopedLogger } from '@camstack/types'
import { packageIsAllowlisted } from '../system-package-allowlist.js'
import { decidePackageInstall } from '../system-package-broker.js'
import { installManifestSystemDeps } from '../manifest-system-deps.js'

function makeLogger(): IScopedLogger {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  logger.withTags.mockReturnValue(logger)
  return logger as unknown as IScopedLogger
}

function declaration(): AddonDeclaration {
  return {
    id: 'smb-storage',
    name: 'SMB Storage',
    version: '0.1.0',
    entry: './dist/smb.addon.js',
    systemDependencies: [
      {
        binary: 'smbclient',
        packages: { apt: 'smbclient', brew: 'samba' },
        reason: 'the SMB provider drives smbclient',
      },
    ],
  } as AddonDeclaration
}

describe('packageIsAllowlisted', () => {
  it('admits smbclient on apt — the one package the SMB provider needs', () => {
    expect(packageIsAllowlisted('apt', 'smbclient')).toBe(true)
  })

  it('refuses a package the addon invented — the helper is not apt-get', () => {
    expect(packageIsAllowlisted('apt', 'nmap')).toBe(false)
    expect(packageIsAllowlisted('apt', 'smbclient; id')).toBe(false)
  })
})

describe('decidePackageInstall', () => {
  it('refuses an unknown package before any install runs', () => {
    const ran: string[] = []
    const decision = decidePackageInstall({
      manager: 'apt',
      packageName: 'nmap',
      helperAvailable: true,
    })
    expect(decision).toEqual({ kind: 'refuse', reason: 'not-allowlisted' })
    expect(ran).toEqual([])
  })

  it('routes apt through the helper when the helper is up', () => {
    expect(
      decidePackageInstall({
        manager: 'apt',
        packageName: 'smbclient',
        helperAvailable: true,
      }),
    ).toEqual({ kind: 'helper' })
  })

  it('does not fall back to in-process apt when the helper is missing — that is uid 1001', () => {
    expect(
      decidePackageInstall({
        manager: 'apt',
        packageName: 'smbclient',
        helperAvailable: false,
      }),
    ).toEqual({ kind: 'refuse', reason: 'helper-unavailable' })
  })

  it('lets brew run in-process — the logged-in user owns Homebrew', () => {
    expect(
      decidePackageInstall({
        manager: 'brew',
        packageName: 'samba',
        helperAvailable: false,
      }),
    ).toEqual({ kind: 'local' })
  })
})

describe('installManifestSystemDeps — apt goes through the helper', () => {
  it('asks the helper instead of spawning apt-get', async () => {
    const run = vi.fn()
    let present = false
    const requestInstall = vi.fn().mockImplementation(async () => {
      present = true
      return { ok: true }
    })
    await installManifestSystemDeps(declaration(), makeLogger(), {
      run,
      requestInstall,
      helperAvailable: async () => true,
      hasBinary: async () => present,
      detectManager: async () => 'apt',
    })
    expect(run).not.toHaveBeenCalled()
    expect(requestInstall).toHaveBeenCalledWith({
      addonId: 'smb-storage',
      binary: 'smbclient',
      manager: 'apt',
      packageName: 'smbclient',
    })
  })

  it('warns helper-unavailable rather than execing apt when the socket is missing', async () => {
    const logger = makeLogger()
    const run = vi.fn()
    await installManifestSystemDeps(declaration(), logger, {
      run,
      helperAvailable: async () => false,
      hasBinary: async () => false,
      detectManager: async () => 'apt',
    })
    expect(run).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('privileged helper'),
      expect.anything(),
    )
  })

  it('still installs through brew in-process', async () => {
    const calls: string[][] = []
    await installManifestSystemDeps(declaration(), makeLogger(), {
      hasBinary: async () => false,
      detectManager: async () => 'brew',
      helperAvailable: async () => false,
      run: async (command, args) => {
        calls.push([command, ...args])
      },
    })
    expect(calls[0]).toEqual(['brew', 'install', 'samba'])
  })
})
