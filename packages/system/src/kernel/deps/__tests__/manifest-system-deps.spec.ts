/**
 * Manifest-declared host binaries — the system-package sibling of
 * `installManifestPythonDeps`.
 *
 * Four properties are load-bearing and each has a test that fails if it is
 * removed: the common path spawns nothing, a failure is never fatal, an
 * unsupported host says so instead of going quiet, and "the package manager
 * exited 0" is not accepted as "the binary is there".
 */
import type { AddonDeclaration, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
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

function declaration(over: Partial<AddonDeclaration> = {}): AddonDeclaration {
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
    ...over,
  } as AddonDeclaration
}

describe('installManifestSystemDeps', () => {
  it('does nothing at all when the addon declares no binaries', async () => {
    const run = vi.fn()
    await installManifestSystemDeps(declaration({ systemDependencies: undefined }), makeLogger(), {
      run,
      hasBinary: async () => false,
      detectManager: async () => 'apt',
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('spawns no package manager when the binary is already present', async () => {
    const run = vi.fn()
    const detectManager = vi.fn()
    await installManifestSystemDeps(declaration(), makeLogger(), {
      run,
      detectManager,
      hasBinary: async () => true,
    })
    expect(run).not.toHaveBeenCalled()
    expect(detectManager).not.toHaveBeenCalled()
  })

  it('does not spawn apt-get in-process — distro installs go through the helper', async () => {
    const run = vi.fn()
    await installManifestSystemDeps(declaration(), makeLogger(), {
      run,
      hasBinary: async () => false,
      detectManager: async () => 'apt',
      helperAvailable: async () => false,
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('uses the brew package name on a host whose manager is brew', async () => {
    const calls: string[][] = []
    await installManifestSystemDeps(declaration(), makeLogger(), {
      hasBinary: async () => false,
      detectManager: async () => 'brew',
      run: async (command, args) => {
        calls.push([command, ...args])
      },
    })
    expect(calls[0]).toEqual(['brew', 'install', 'samba'])
  })

  it('warns and returns — never throws — when the helper install fails', async () => {
    const logger = makeLogger()
    await expect(
      installManifestSystemDeps(declaration(), logger, {
        hasBinary: async () => false,
        detectManager: async () => 'apt',
        helperAvailable: async () => true,
        requestInstall: async () => ({ ok: false, error: 'E: Unable to locate package smbclient' }),
        run: async () => {
          throw new Error('must not run')
        },
      }),
    ).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('install failed'),
      expect.anything(),
    )
  })

  it('says so when no supported package manager exists, rather than going quiet', async () => {
    const logger = makeLogger()
    await installManifestSystemDeps(declaration(), logger, {
      hasBinary: async () => false,
      detectManager: async () => null,
      run: async () => {
        throw new Error('must not run')
      },
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no supported package manager'),
      expect.anything(),
    )
  })

  it('says so when the addon declares no package for THIS host’s manager', async () => {
    const logger = makeLogger()
    await installManifestSystemDeps(declaration(), logger, {
      hasBinary: async () => false,
      detectManager: async () => 'apk',
      run: async () => {
        throw new Error('must not run')
      },
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no package for this manager'),
      expect.anything(),
    )
  })

  it('refuses to call a helper ok a success when the binary still does not resolve', async () => {
    const logger = makeLogger()
    await installManifestSystemDeps(declaration(), logger, {
      hasBinary: async () => false,
      detectManager: async () => 'apt',
      helperAvailable: async () => true,
      requestInstall: async () => ({ ok: true }),
    })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('still does not resolve'),
      expect.anything(),
    )
    expect(logger.info).not.toHaveBeenCalledWith('system dependency installed', expect.anything())
  })
})
