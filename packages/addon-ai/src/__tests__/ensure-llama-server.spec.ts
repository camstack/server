import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  LLAMA_SERVER_VERSION,
  cachedBinaryPath,
  ensureLlamaServer,
  llamaServerAsset,
} from '../runtime/ensure-llama-server.js'
import { makeTestLogger } from './support/logger.js'

const logger = makeTestLogger()

let binDir: string

beforeEach(async () => {
  binDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'llama-bin-'))
})
afterEach(async () => {
  await fsp.rm(binDir, { recursive: true, force: true })
})

describe('llamaServerAsset', () => {
  it('returns pinned entries for supported platforms', () => {
    expect(llamaServerAsset('linux', 'x64').fileName).toContain('ubuntu-x64')
    expect(llamaServerAsset('darwin', 'arm64').fileName).toContain('macos-arm64')
    expect(llamaServerAsset('linux', 'x64').binaryPathInArchive).toBe(
      `${LLAMA_SERVER_VERSION}/llama-server`,
    )
  })
  it('throws on an unsupported platform', () => {
    expect(() => llamaServerAsset('win32', 'x64')).toThrow()
  })
})

describe('ensureLlamaServer', () => {
  it('returns a PATH binary that probes ok, never downloading', async () => {
    let downloaded = false
    const bin = await ensureLlamaServer({
      binDir,
      logger,
      probe: async (b) => b === 'llama-server',
      download: async () => {
        downloaded = true
      },
      extract: async () => {},
      fileSha256: async () => 'x',
      pathBinary: 'llama-server',
    })
    expect(bin).toBe('llama-server')
    expect(downloaded).toBe(false)
  })

  it('reuses a cached version-keyed binary that probes ok', async () => {
    const cached = cachedBinaryPath(binDir, LLAMA_SERVER_VERSION)
    await fsp.mkdir(path.dirname(cached), { recursive: true })
    await fsp.writeFile(cached, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    let downloaded = false
    const bin = await ensureLlamaServer({
      binDir,
      logger,
      probe: async (b) => b === cached,
      download: async () => {
        downloaded = true
      },
      extract: async () => {},
      fileSha256: async () => 'x',
      pathBinary: null,
    })
    expect(bin).toBe(cached)
    expect(downloaded).toBe(false)
  })

  it('ignores a cached binary from a DIFFERENT version and downloads', async () => {
    const stale = cachedBinaryPath(binDir, 'b0000')
    await fsp.mkdir(path.dirname(stale), { recursive: true })
    await fsp.writeFile(stale, 'old', { mode: 0o755 })
    const asset = llamaServerAsset(os.platform(), os.arch())
    let downloaded = false
    const bin = await ensureLlamaServer({
      binDir,
      logger,
      probe: async () => true,
      download: async (_url, dest) => {
        downloaded = true
        await fsp.writeFile(dest, 'archive')
      },
      extract: async (_archive, _entry, destBin) => {
        await fsp.writeFile(destBin, 'binary', { mode: 0o755 })
      },
      fileSha256: async () => asset.sha256,
      pathBinary: null,
    })
    expect(downloaded).toBe(true)
    expect(bin).toBe(cachedBinaryPath(binDir, LLAMA_SERVER_VERSION))
  })

  it('downloads, sha-verifies, chmods, probes, returns', async () => {
    const asset = llamaServerAsset(os.platform(), os.arch())
    const bin = await ensureLlamaServer({
      binDir,
      logger,
      probe: async () => true,
      download: async (_url, dest) => {
        await fsp.writeFile(dest, 'archive')
      },
      extract: async (_archive, _entry, destBin) => {
        await fsp.writeFile(destBin, 'binary')
      },
      fileSha256: async () => asset.sha256,
      pathBinary: null,
    })
    expect(fs.existsSync(bin)).toBe(true)
    expect((fs.statSync(bin).mode & 0o111) !== 0).toBe(true)
  })

  it('sha mismatch → deletes the archive + throws', async () => {
    let dest = ''
    await expect(
      ensureLlamaServer({
        binDir,
        logger,
        probe: async () => true,
        download: async (_url, d) => {
          dest = d
          await fsp.writeFile(d, 'archive')
        },
        extract: async () => {},
        fileSha256: async () => 'deadbeef',
        pathBinary: null,
      }),
    ).rejects.toThrow(/sha256/i)
    expect(fs.existsSync(dest)).toBe(false)
  })

  it('failed post-download probe → throws', async () => {
    const asset = llamaServerAsset(os.platform(), os.arch())
    await expect(
      ensureLlamaServer({
        binDir,
        logger,
        probe: async () => false,
        download: async (_url, dest) => {
          await fsp.writeFile(dest, 'archive')
        },
        extract: async (_archive, _entry, destBin) => {
          await fsp.writeFile(destBin, 'binary')
        },
        fileSha256: async () => asset.sha256,
        pathBinary: null,
      }),
    ).rejects.toThrow()
  })
})
