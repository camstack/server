/**
 * Pack/unpack of hub `dev-uploads/<version>/` for agent propagate.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeDevUploadManifest, serverRootDir } from '../../server-root/index.js'
import {
  isSafeDevUploadVersion,
  packDevUploadVersionDir,
  unpackDevUploadVersionBundle,
} from '../dev-uploads-bundle.js'

const VERSION = '1.2.500-dev.1791665599'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-uploads-bundle-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function seedVersionDir(root: string): string {
  const versionDir = path.join(root, 'dev-uploads', VERSION)
  fs.mkdirSync(versionDir, { recursive: true })
  fs.writeFileSync(path.join(versionDir, 'camstack-server.tgz'), Buffer.from('server-bytes'))
  fs.writeFileSync(path.join(versionDir, 'camstack-types.tgz'), Buffer.from('types-bytes'))
  writeDevUploadManifest(versionDir, {
    version: VERSION,
    packages: {
      '@camstack/server': 'camstack-server.tgz',
      '@camstack/types': 'camstack-types.tgz',
    },
  })
  return versionDir
}

describe('isSafeDevUploadVersion', () => {
  it('accepts a shaped dev version', () => {
    expect(isSafeDevUploadVersion(VERSION)).toBe(true)
  })
  it('refuses traversal and non-dev shapes', () => {
    expect(isSafeDevUploadVersion('../evil-dev.1')).toBe(false)
    expect(isSafeDevUploadVersion('1.2.3')).toBe(false)
  })
})

describe('packDevUploadVersionDir / unpackDevUploadVersionBundle', () => {
  it('round-trips tarballs + manifest into another server-root', async () => {
    const hubRoot = path.join(tmp, 'hub-root')
    const versionDir = seedVersionDir(hubRoot)
    const packed = await packDevUploadVersionDir(versionDir)
    expect(packed.length).toBeGreaterThan(20)

    const agentData = path.join(tmp, 'agent-data')
    const result = await unpackDevUploadVersionBundle({
      serverRoot: serverRootDir(agentData),
      version: VERSION,
      bundle: packed,
    })
    expect(result.packageCount).toBe(2)
    expect(fs.existsSync(path.join(result.versionDir, 'manifest.json'))).toBe(true)
    expect(fs.readFileSync(path.join(result.versionDir, 'camstack-server.tgz'))).toEqual(
      Buffer.from('server-bytes'),
    )
  })

  it('refuses an archive entry with a path separator', async () => {
    const hubRoot = path.join(tmp, 'hub-root')
    const versionDir = seedVersionDir(hubRoot)
    const evil = path.join(versionDir, 'nested')
    fs.mkdirSync(evil)
    fs.writeFileSync(path.join(evil, 'x.tgz'), 'x')
    const { execFileSync } = await import('node:child_process')
    const badTgz = path.join(tmp, 'bad.tgz')
    execFileSync('tar', ['-czf', badTgz, '-C', versionDir, 'nested/x.tgz'])
    await expect(
      unpackDevUploadVersionBundle({
        serverRoot: serverRootDir(path.join(tmp, 'agent')),
        version: VERSION,
        bundle: fs.readFileSync(badTgz),
      }),
    ).rejects.toThrow(/basename/)
  })
})
