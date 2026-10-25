import { describe, it, expect, vi } from 'vitest'
import * as path from 'node:path'
import {
  decidePrune,
  isPrunableDir,
  prunePlacementLeftovers,
  type InstalledAddonDir,
} from '../core/addon/prune-misplaced-addons.js'

const ROOT = '/data/addons/@camstack'

function installed(over: Partial<InstalledAddonDir> = {}): InstalledAddonDir {
  return {
    packageName: '@camstack/addon-agent-ui',
    dir: path.join(ROOT, 'addon-agent-ui'),
    placement: 'agent-only',
    ...over,
  }
}

describe('deciding what to prune', () => {
  it('prunes an agent-only addon found on the hub', () => {
    // The live case: installed 2026-07-22 by a build that predated the
    // installer fix, skipped by the loader ever since, and therefore shown as
    // FAILED forever on a node where it cannot run.
    const d = decidePrune([installed()], 'hub')
    expect(d).toHaveLength(1)
    expect(d[0]?.packageName).toBe('@camstack/addon-agent-ui')
  })

  it('leaves hub-only and any-node addons alone', () => {
    const d = decidePrune(
      [installed({ placement: 'hub-only' }), installed({ placement: 'any-node' })],
      'hub',
    )
    expect(d).toEqual([])
  })

  it('does nothing on an agent', () => {
    // An agent seeds its addon set from the hub's closure, so a hub-only entry
    // there is expected to be inert. Pruning it would fight the seeding.
    expect(decidePrune([installed({ placement: 'hub-only' })], 'agent')).toEqual([])
  })
})

describe('the path guard', () => {
  it('accepts exactly one level under the addon scope', () => {
    expect(isPrunableDir(path.join(ROOT, 'addon-agent-ui'), ROOT)).toBe(true)
  })

  it('refuses the scope root itself', () => {
    expect(isPrunableDir(ROOT, ROOT)).toBe(false)
  })

  it('refuses anything outside, however it is spelled', () => {
    expect(isPrunableDir('/data/recordings', ROOT)).toBe(false)
    expect(isPrunableDir(path.join(ROOT, '..', '..', 'etc'), ROOT)).toBe(false)
  })

  it('refuses a nested path inside an addon', () => {
    // Removing `<addon>/dist` would leave a half-addon, which is worse than
    // either keeping or removing it.
    expect(isPrunableDir(path.join(ROOT, 'addon-agent-ui', 'dist'), ROOT)).toBe(false)
  })
})

describe('applying the prune', () => {
  const logger = () => ({ info: vi.fn(), warn: vi.fn() })

  it('removes the directory and says so', () => {
    const log = logger()
    const rm = vi.fn()
    const removed = prunePlacementLeftovers(decidePrune([installed()], 'hub'), ROOT, log, rm)
    expect(removed).toEqual(['@camstack/addon-agent-ui'])
    expect(rm).toHaveBeenCalledWith(path.join(ROOT, 'addon-agent-ui'))
    // A directory vanishing at boot must never be discovered by noticing it is
    // gone.
    expect(log.info).toHaveBeenCalled()
  })

  it('refuses an out-of-scope path instead of deleting it', () => {
    const log = logger()
    const rm = vi.fn()
    const removed = prunePlacementLeftovers(
      [{ packageName: 'x', dir: '/etc', reason: 'nope' }],
      ROOT,
      log,
      rm,
    )
    expect(rm).not.toHaveBeenCalled()
    expect(removed).toEqual([])
    expect(log.warn).toHaveBeenCalled()
  })

  it('a failed removal never aborts boot, and never stops the others', () => {
    const log = logger()
    const rm = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('EBUSY')
      })
      .mockImplementationOnce(() => undefined)
    const removed = prunePlacementLeftovers(
      [
        { packageName: 'a', dir: path.join(ROOT, 'a'), reason: 'r' },
        { packageName: 'b', dir: path.join(ROOT, 'b'), reason: 'r' },
      ],
      ROOT,
      log,
      rm,
    )
    // The worst case is the state we started from, not a hub that will not boot.
    expect(removed).toEqual(['b'])
    expect(log.warn).toHaveBeenCalled()
  })
})
