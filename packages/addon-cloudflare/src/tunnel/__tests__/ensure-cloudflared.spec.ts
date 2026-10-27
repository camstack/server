import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import {
  DEFAULT_CLOUDFLARED_VERSION,
  MIN_CLOUDFLARED_VERSION,
  cloudflaredAsset,
  ensureCloudflared,
  type ChecksumTable,
  type EnsureCloudflaredDeps,
} from '../ensure-cloudflared'
import { parseCloudflaredVersion, versionAtLeast } from '../cloudflared-invocation'

const MIN_VERSION_STRING = '2026.10.5'

describe('cloudflaredAsset', () => {
  it('maps linux arches to bare binaries', () => {
    expect(cloudflaredAsset('linux', 'x64')).toEqual({
      fileName: 'cloudflared-linux-amd64',
      isArchive: false,
    })
    expect(cloudflaredAsset('linux', 'arm64')).toEqual({
      fileName: 'cloudflared-linux-arm64',
      isArchive: false,
    })
    expect(cloudflaredAsset('linux', 'arm')).toEqual({
      fileName: 'cloudflared-linux-arm',
      isArchive: false,
    })
  })

  it('maps darwin to a .tgz archive (arm64 falls back to amd64 via Rosetta)', () => {
    expect(cloudflaredAsset('darwin', 'x64')).toEqual({
      fileName: 'cloudflared-darwin-amd64.tgz',
      isArchive: true,
    })
    expect(cloudflaredAsset('darwin', 'arm64')).toEqual({
      fileName: 'cloudflared-darwin-amd64.tgz',
      isArchive: true,
    })
  })

  it('maps win32 to a .exe', () => {
    expect(cloudflaredAsset('win32', 'x64')).toEqual({
      fileName: 'cloudflared-windows-amd64.exe',
      isArchive: false,
    })
  })

  it('throws on an unsupported arch or platform', () => {
    expect(() => cloudflaredAsset('linux', 'mips')).toThrow(/unsupported arch/)
    expect(() => cloudflaredAsset('freebsd' as NodeJS.Platform, 'x64')).toThrow(
      /unsupported platform/,
    )
  })
})

describe('ensureCloudflared minimum version', () => {
  const asset = cloudflaredAsset(os.platform(), os.arch())
  const binName = os.platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const banner = (v: string): string => `cloudflared version ${v} (built 2026-10-27-1305 UTC)`
  const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
  const goodContent = banner(MIN_VERSION_STRING)
  let binDir: string

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ensure-'))
  })
  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true })
  })

  function logger(): { log: IScopedLogger; lines: string[] } {
    const lines: string[] = []
    const rec = (msg: string, ctx?: { meta?: Record<string, unknown> }): void => {
      lines.push(`${msg} ${JSON.stringify(ctx?.meta ?? {})}`)
    }
    const log = {
      debug: rec,
      info: rec,
      warn: rec,
      error: rec,
      child: () => log,
    }
    return { log: log as unknown as IScopedLogger, lines }
  }

  /** Fake "binaries": a file's text IS its --version output; PATH is a variable. */
  function harness(opts: { pathVersion?: string; download?: string }): {
    deps: EnsureCloudflaredDeps
    downloads: string[]
  } {
    const downloads: string[] = []
    const body = opts.download ?? goodContent
    const deps: EnsureCloudflaredDeps = {
      probeVersion: async (bin) => {
        if (bin === 'cloudflared') return opts.pathVersion ? banner(opts.pathVersion) : null
        return fs.existsSync(bin) ? fs.readFileSync(bin, 'utf8') : null
      },
      download: async (url, dest) => {
        downloads.push(url)
        fs.writeFileSync(dest, body)
      },
      extract: async (_archive, intoDir) => {
        fs.writeFileSync(path.join(intoDir, 'cloudflared'), body)
      },
    }
    return { deps, downloads }
  }

  const checksumsFor = (content: string): ChecksumTable => ({
    [DEFAULT_CLOUDFLARED_VERSION]: { [asset.fileName]: sha(content) },
  })

  it('parses the real --version banner', () => {
    expect(parseCloudflaredVersion(banner('2026.10.5'))).toEqual([2026, 10, 5])
  })

  it('the pin satisfies the minimum, and the minimum is the certificate-fix release', () => {
    expect(MIN_CLOUDFLARED_VERSION.join('.')).toBe(MIN_VERSION_STRING)
    expect(DEFAULT_CLOUDFLARED_VERSION).toBe('2026.10.5')
    expect(
      versionAtLeast(parseCloudflaredVersion(DEFAULT_CLOUDFLARED_VERSION), MIN_CLOUDFLARED_VERSION),
    ).toBe(true)
  })

  it('replaces an old cached copy with the verified pinned download', async () => {
    const cached = path.join(binDir, binName)
    fs.writeFileSync(cached, banner('2025.4.2'))
    const h = harness({})
    const l = logger()
    const got = await ensureCloudflared({
      binDir,
      logger: l.log,
      deps: h.deps,
      checksums: checksumsFor(goodContent),
    })
    expect(got).toBe(cached)
    expect(fs.readFileSync(cached, 'utf8')).toBe(goodContent)
    expect(h.downloads).toHaveLength(1)
    expect(l.lines.join('\n')).toMatch(/2025\.4\.2/)
    expect(fs.readdirSync(binDir)).toEqual([binName])
  })

  it('skips a PATH copy below the minimum and uses the pinned download', async () => {
    const h = harness({ pathVersion: '2025.4.2' })
    const got = await ensureCloudflared({
      binDir,
      logger: logger().log,
      deps: h.deps,
      checksums: checksumsFor(goodContent),
    })
    expect(got).toBe(path.join(binDir, binName))
    expect(h.downloads).toHaveLength(1)
  })

  it('reuses a PATH copy at the minimum without downloading', async () => {
    const h = harness({ pathVersion: '2026.10.5' })
    expect(await ensureCloudflared({ binDir, logger: logger().log, deps: h.deps })).toBe(
      'cloudflared',
    )
    expect(h.downloads).toHaveLength(0)
  })

  it('reuses a cached copy above the minimum without downloading', async () => {
    const cached = path.join(binDir, binName)
    fs.writeFileSync(cached, banner('2026.11.0'))
    const h = harness({})
    expect(await ensureCloudflared({ binDir, logger: logger().log, deps: h.deps })).toBe(cached)
    expect(h.downloads).toHaveLength(0)
  })

  it('refuses a checksum mismatch and keeps the old binary', async () => {
    const cached = path.join(binDir, binName)
    fs.writeFileSync(cached, banner('2025.4.2'))
    const h = harness({ download: 'tampered' })
    await expect(
      ensureCloudflared({
        binDir,
        logger: logger().log,
        deps: h.deps,
        checksums: checksumsFor(goodContent),
      }),
    ).rejects.toThrow(/checksum/i)
    expect(fs.readFileSync(cached, 'utf8')).toBe(banner('2025.4.2'))
    expect(fs.readdirSync(binDir)).toEqual([binName])
  })

  it('refuses a verified download that is below the minimum, keeping the old binary', async () => {
    const cached = path.join(binDir, binName)
    fs.writeFileSync(cached, banner('2025.4.2'))
    const stale = banner('2025.9.0')
    const h = harness({ download: stale })
    await expect(
      ensureCloudflared({
        binDir,
        logger: logger().log,
        deps: h.deps,
        checksums: checksumsFor(stale),
      }),
    ).rejects.toThrow(/minimum/i)
    expect(fs.readFileSync(cached, 'utf8')).toBe(banner('2025.4.2'))
    expect(fs.readdirSync(binDir)).toEqual([binName])
  })

  it('refuses a version with no known checksum', async () => {
    const h = harness({})
    await expect(
      ensureCloudflared({
        binDir,
        logger: logger().log,
        deps: h.deps,
        version: '2099.1.1',
      }),
    ).rejects.toThrow(/checksum/i)
  })

  describe('binDir sweep', () => {
    const leftovers = (): string[] => {
      fs.mkdirSync(path.join(binDir, '.provision-dead'))
      fs.writeFileSync(path.join(binDir, '.provision-dead', 'x'), 'partial')
      fs.writeFileSync(path.join(binDir, 'cloudflared-darwin-amd64.tgz'), 'old archive')
      fs.writeFileSync(path.join(binDir, 'cloudflared.2025.4.2.bak'), 'bak')
      fs.writeFileSync(path.join(binDir, 'cloudflared.new'), 'new')
      fs.writeFileSync(path.join(binDir, 'cloudflared.exe.old'), 'old')
      return fs.readdirSync(binDir).filter((n) => n !== binName)
    }

    it('removes every leftover after a replacement and logs what it freed', async () => {
      fs.writeFileSync(path.join(binDir, binName), banner('2025.4.2'))
      leftovers()
      const l = logger()
      await ensureCloudflared({
        binDir,
        logger: l.log,
        deps: harness({}).deps,
        checksums: checksumsFor(goodContent),
      })
      expect(fs.readdirSync(binDir)).toEqual([binName])
      expect(l.lines.join('\n')).toMatch(/cloudflared\.new/)
      expect(l.lines.join('\n')).toMatch(/bytes/i)
    })

    it('removes leftovers when the cached copy is reused, keeping the binary', async () => {
      const cached = path.join(binDir, binName)
      fs.writeFileSync(cached, banner('2026.11.0'))
      leftovers()
      const h = harness({})
      expect(await ensureCloudflared({ binDir, logger: logger().log, deps: h.deps })).toBe(cached)
      expect(h.downloads).toHaveLength(0)
      expect(fs.readdirSync(binDir)).toEqual([binName])
      expect(fs.readFileSync(cached, 'utf8')).toBe(banner('2026.11.0'))
    })

    it('sweeps the stale cached copy too when PATH cloudflared is used', async () => {
      fs.writeFileSync(path.join(binDir, binName), banner('2025.4.2'))
      leftovers()
      const got = await ensureCloudflared({
        binDir,
        logger: logger().log,
        deps: harness({ pathVersion: '2026.10.5' }).deps,
      })
      expect(got).toBe('cloudflared')
      expect(fs.readdirSync(binDir)).toEqual([])
    })

    it('unlinks a symlink pointing outside binDir and leaves its target untouched', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-outside-'))
      try {
        fs.writeFileSync(path.join(outside, 'keep.txt'), 'precious')
        fs.symlinkSync(outside, path.join(binDir, 'link-dir'))
        fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(binDir, 'link-file'))
        const cached = path.join(binDir, binName)
        fs.writeFileSync(cached, banner('2026.11.0'))
        await ensureCloudflared({ binDir, logger: logger().log, deps: harness({}).deps })
        expect(fs.readdirSync(binDir)).toEqual([binName])
        expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('precious')
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })

    it('a removal error warns and does not fail provisioning', async () => {
      const cached = path.join(binDir, binName)
      fs.writeFileSync(cached, banner('2026.11.0'))
      fs.writeFileSync(path.join(binDir, 'cloudflared.bak'), 'bak')
      const l = logger()
      const h = harness({})
      const deps: EnsureCloudflaredDeps = {
        ...h.deps,
        remove: async () => {
          throw new Error('EBUSY')
        },
      }
      expect(await ensureCloudflared({ binDir, logger: l.log, deps })).toBe(cached)
      expect(l.lines.join('\n')).toMatch(/EBUSY/)
    })
  })
})
