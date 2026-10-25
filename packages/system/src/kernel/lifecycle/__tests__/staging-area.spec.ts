import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { StagingArea } from '../staging-area.js'

let dir: string
const fakeTgz = Buffer.from('fake')

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-'))
})

const writePkg = (v: string) => async (_t: Buffer, d: string) => {
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(
    path.join(d, 'package.json'),
    JSON.stringify({ name: '@camstack/addon-x', version: v }),
  )
}

describe('StagingArea', () => {
  it('stages a valid package', async () => {
    const sa = new StagingArea(dir, {
      fetchTarball: async () => fakeTgz,
      extract: writePkg('1.0.1'),
    })
    const { stagedPath } = await sa.fetchAndStage({
      jobId: 'j1',
      name: '@camstack/addon-x',
      version: '1.0.1',
      signal: new AbortController().signal,
    })
    expect(fs.existsSync(path.join(stagedPath, 'package.json'))).toBe(true)
  })

  it('rejects version mismatch', async () => {
    const sa = new StagingArea(dir, {
      fetchTarball: async () => fakeTgz,
      extract: writePkg('9.9.9'),
    })
    await expect(
      sa.fetchAndStage({
        jobId: 'j2',
        name: '@camstack/addon-x',
        version: '1.0.1',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/version/i)
  })

  it('accepts a dist-tag by validating the RESOLVED version, not the literal', async () => {
    // `updatePackage` without an explicit version asks for 'latest'. The
    // fetcher resolves the tag; the staged package.json then carries the real
    // version, and comparing it to the literal 'latest' failed EVERY tag-based
    // update (30/30 on 2026-08-20).
    const sa = new StagingArea(dir, {
      fetchTarball: async () => fakeTgz,
      extract: writePkg('0.1.26'),
    })
    const { stagedPath, resolvedVersion } = await sa.fetchAndStage({
      jobId: 'j4',
      name: '@camstack/addon-x',
      version: 'latest',
      signal: new AbortController().signal,
    })
    expect(fs.existsSync(path.join(stagedPath, 'package.json'))).toBe(true)
    expect(resolvedVersion).toBe('0.1.26')
  })

  it('still rejects a dist-tag staging whose package.json has no version', async () => {
    const sa = new StagingArea(dir, {
      fetchTarball: async () => fakeTgz,
      extract: async (_t, destDir) => {
        fs.mkdirSync(destDir, { recursive: true })
        fs.writeFileSync(
          path.join(destDir, 'package.json'),
          JSON.stringify({ name: '@camstack/addon-x' }),
        )
      },
    })
    await expect(
      sa.fetchAndStage({
        jobId: 'j5',
        name: '@camstack/addon-x',
        version: 'latest',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/version/i)
  })

  it('propagates an aborted fetch', async () => {
    const ac = new AbortController()
    ac.abort()
    const sa = new StagingArea(dir, {
      fetchTarball: async (_n, _v, s) => {
        if (s.aborted) throw new Error('aborted')
        return fakeTgz
      },
      extract: async () => {},
    })
    await expect(
      sa.fetchAndStage({
        jobId: 'j3',
        name: '@camstack/addon-x',
        version: '1.0.1',
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/i)
  })
})
