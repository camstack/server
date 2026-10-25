/**
 * `memoizePinnedFfmpeg` — the node's pinned ffmpeg, asked once on success and
 * asked AGAIN after a failure, so a node whose first download failed recovers
 * on the next spawn that needs the binary rather than never.
 */
import { describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { memoizePinnedFfmpeg } from '../ffmpeg/pinned-binary.js'
import { pinnedFfmpegSpawner } from '../ffmpeg/pinned-spawn.js'

describe('memoizePinnedFfmpeg', () => {
  it('asks the resolver once and serves every later caller the same path', async () => {
    let calls = 0
    const resolve = memoizePinnedFfmpeg(async () => {
      calls += 1
      return '/data/deps/ffmpeg-8.1.2-5'
    })
    expect(await resolve()).toBe('/data/deps/ffmpeg-8.1.2-5')
    expect(await resolve()).toBe('/data/deps/ffmpeg-8.1.2-5')
    expect(calls).toBe(1)
  })

  it('coalesces concurrent callers onto the one attempt in flight', async () => {
    let calls = 0
    const resolve = memoizePinnedFfmpeg(async () => {
      calls += 1
      return '/deps/ffmpeg'
    })
    await Promise.all([resolve(), resolve(), resolve()])
    expect(calls).toBe(1)
  })

  it('REJECTS when the pinned build is unavailable — there is no default to fall back to', async () => {
    const resolve = memoizePinnedFfmpeg(async () => {
      throw new Error('download failed')
    })
    await expect(resolve()).rejects.toThrow('download failed')
  })

  it('does not remember a failure: the next caller asks again and can succeed', async () => {
    let calls = 0
    const resolve = memoizePinnedFfmpeg(async () => {
      calls += 1
      if (calls === 1) throw new Error('no network yet')
      return '/deps/ffmpeg'
    })
    await expect(resolve()).rejects.toThrow('no network yet')
    expect(await resolve()).toBe('/deps/ffmpeg')
    expect(calls).toBe(2)
  })
})

describe('pinnedFfmpegSpawner', () => {
  it('prefers the injected seam — a spec never needs a binary', () => {
    const seam = (): ChildProcess => {
      throw new Error('seam called')
    }
    expect(pinnedFfmpegSpawner(seam, null, {})).toBe(seam)
  })

  it('answers null when there is no pinned binary — the site refuses, never PATH', () => {
    expect(pinnedFfmpegSpawner(undefined, null, {})).toBeNull()
  })

  it('spawns EXACTLY the pinned path it was given', async () => {
    // Node itself stands in for the binary: the assertion is on which FILE
    // was spawned, and node is the one executable every test machine has.
    const spawnWith = pinnedFfmpegSpawner(undefined, process.execPath, { stdio: 'ignore' })
    expect(spawnWith).not.toBeNull()
    const child = spawnWith?.(['-e', '0'])
    expect(child?.spawnfile).toBe(process.execPath)
    await new Promise<void>((resolve) => child?.once('exit', () => resolve()))
  })
})
