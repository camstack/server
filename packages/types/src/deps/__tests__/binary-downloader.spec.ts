import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import type { IScopedLogger } from '../../interfaces/logging.js'
import {
  downloadBinary,
  getPlatformInfo,
  buildBinaryPath,
  findFileByName,
} from '../binary-downloader.js'

/** A logger that says nothing — these tests are about bytes, not lines. */
function silentLogger(): IScopedLogger {
  const noop = (): void => undefined
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}

describe('getPlatformInfo', () => {
  it('returns current platform and arch', () => {
    const info = getPlatformInfo()
    expect(['darwin', 'linux', 'win32']).toContain(info.platform)
    expect(['x64', 'arm64', 'arm', 'ia32']).toContain(info.arch)
  })
})

describe('findFileByName (archive-extraction fallback)', () => {
  let root: string
  beforeAll(() => {
    // Mimic johnvansickle's layout: a version/arch-named top dir the hardcoded
    // inner path can't predict — `ffmpeg-<version>-<arch>-static/ffmpeg`.
    root = mkdtempSync(join(tmpdir(), 'bindl-'))
    const inner = join(root, 'ffmpeg-6.1.1-arm64-static')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(inner, 'ffmpeg'), '#!/bin/true\n')
    writeFileSync(join(inner, 'ffprobe'), '#!/bin/true\n')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('finds the binary in an unpredictably-named nested dir', () => {
    const found = findFileByName(root, 'ffmpeg')
    expect(found).toBe(join(root, 'ffmpeg-6.1.1-arm64-static', 'ffmpeg'))
  })

  it('returns null when the binary is absent', () => {
    expect(findFileByName(root, 'nonesuch')).toBeNull()
  })

  it('returns null for an unreadable/missing dir (no throw)', () => {
    expect(findFileByName(join(root, 'does-not-exist'), 'ffmpeg')).toBeNull()
  })
})

describe('buildBinaryPath', () => {
  it('builds path from deps dir and binary name', () => {
    const result = buildBinaryPath('/opt/camstack/data', 'ffmpeg')
    expect(result).toBe('/opt/camstack/data/deps/ffmpeg')
  })

  it('appends .exe on windows', () => {
    const result = buildBinaryPath('/opt/camstack/data', 'ffmpeg', 'win32')
    expect(result).toBe('/opt/camstack/data/deps/ffmpeg.exe')
  })
})

/**
 * A pinned checksum, and what happens when the bytes do not match it.
 *
 * The ffmpeg download is now the ONLY source of the binary every transcode runs
 * through: the container image ships none. It arrives over a redirect to a
 * third-party host, and the publisher ships no checksums of its own — so the
 * one we pin is the only thing standing between a changed artifact and a silent
 * swap of the most privileged subprocess this system spawns.
 *
 * A mismatch is terminal on purpose. "Not what was verified" is the one state
 * in which running the binary is worse than not having it, and the partial file
 * is removed so a retry cannot pick it up.
 */
describe('downloadBinary checksum verification', () => {
  it('refuses an artifact whose bytes are not the ones we pinned, and deletes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camstack-dl-'))
    const body = Buffer.from('not the artifact you pinned')
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch
    try {
      await expect(
        downloadBinary({
          name: 'ffmpeg',
          url: 'https://example.invalid/ffmpeg',
          targetDir: dir,
          targetName: 'ffmpeg-test',
          logger: silentLogger(),
          sha256: 'f'.repeat(64),
        }),
      ).rejects.toThrow(/pinned checksum/i)
      expect(existsSync(join(dir, 'ffmpeg-test'))).toBe(false)
    } finally {
      globalThis.fetch = realFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts the artifact when the checksum matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camstack-dl-'))
    const body = Buffer.from('the real thing')
    const digest = createHash('sha256').update(body).digest('hex')
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch
    try {
      const out = await downloadBinary({
        name: 'ffmpeg',
        url: 'https://example.invalid/ffmpeg',
        targetDir: dir,
        targetName: 'ffmpeg-test',
        logger: silentLogger(),
        sha256: digest,
      })
      expect(existsSync(out)).toBe(true)
    } finally {
      globalThis.fetch = realFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The Windows ffmpeg archive is flat and its binary is `ffmpeg.exe`. The
 * recursive fallback used to look for the bare name `ffmpeg`, which no file in
 * that archive has, so the download "succeeded" and then threw "not found".
 */
describe('downloadBinary archive fallback on a name with an extension', () => {
  it('finds ffmpeg.exe when asked for the ffmpeg binary named ffmpeg.exe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camstack-dl-'))
    const src = join(dir, 'src')
    mkdirSync(src)
    writeFileSync(join(src, 'ffmpeg.exe'), 'MZ-ffmpeg')
    writeFileSync(join(src, 'ffprobe.exe'), 'MZ-ffprobe')
    const tarball = join(dir, 'fixture.tar.gz')
    execFileSync('tar', ['-czf', tarball, '-C', src, 'ffmpeg.exe', 'ffprobe.exe'])
    const body = readFileSync(tarball)
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch
    try {
      const out = await downloadBinary({
        name: 'ffmpeg',
        url: 'https://example.invalid/ffmpeg.tar.gz',
        targetDir: join(dir, 'deps'),
        targetName: 'ffmpeg.exe',
        logger: silentLogger(),
        isArchive: true,
        archiveFormat: 'tar.gz',
        archiveInnerPath: 'ffmpeg',
      })
      expect(readFileSync(out, 'utf8')).toBe('MZ-ffmpeg')
    } finally {
      globalThis.fetch = realFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
