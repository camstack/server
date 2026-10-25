/**
 * The staging sweep must never delete a LIVE install.
 *
 * `installFromTgz` opened by clearing the whole `.staging` root. Two deploys
 * arriving inside one install's lifetime — routine when the hub propagates two
 * packages back to back — meant the newcomer deleted the incumbent's tree while
 * its `npm install` was still reading from it:
 *
 *   npm error code ENOENT
 *   npm error path …/.staging/install-14820-2026-08-07T12-28-28-875Z/package/package.json
 *
 * surfaced to the operator as `runtime dependency install failed`. Seen on both
 * the Mac desktop agent and agent-a on 2026-08-07.
 */
import { describe, expect, it } from 'vitest'
import { STAGING_RESIDUE_MIN_AGE_MS, selectSweepableStaging } from '../addon-installer.js'

const OLD = STAGING_RESIDUE_MIN_AGE_MS + 60_000
const YOUNG = 5_000

describe('selectSweepableStaging', () => {
  it('never sweeps a staging tree this process is building', () => {
    const sweepable = selectSweepableStaging(
      [{ name: 'install-1-mine', ageMs: OLD }],
      new Set(['install-1-mine']),
    )
    expect(sweepable).toEqual([])
  })

  it('never sweeps a young tree — it may be another process mid-install', () => {
    const sweepable = selectSweepableStaging(
      [{ name: 'install-99-theirs', ageMs: YOUNG }],
      new Set(),
    )
    expect(sweepable).toEqual([])
  })

  it('sweeps residue old enough that no install can still own it', () => {
    const sweepable = selectSweepableStaging([{ name: 'install-7-dead', ageMs: OLD }], new Set())
    expect(sweepable).toEqual(['install-7-dead'])
  })

  it('separates the live from the dead in one pass', () => {
    const sweepable = selectSweepableStaging(
      [
        { name: 'install-1-mine', ageMs: OLD },
        { name: 'install-2-running-elsewhere', ageMs: YOUNG },
        { name: 'install-3-crashed', ageMs: OLD },
      ],
      new Set(['install-1-mine']),
    )
    expect(sweepable).toEqual(['install-3-crashed'])
  })
})
