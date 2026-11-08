/**
 * `restoredStateFields` (D1024): a `restored` cap may name the ONLY fields that
 * reach disk and come back at boot. `climate-control.lastActiveMode` is the case
 * that needs it — the provider re-reports the mode the device is in NOW, never
 * the one it ran before it was switched off, so that one field has to outlive a
 * restart while the live readings must not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatePolicy } from '@camstack/types'
import { runtimeStatePolicyFor } from '@camstack/types'
import { persistableBlob } from '../runtime-state-persist-gate.js'
import { flushDebounce, harness } from './mirror-harness.js'

const DEVICE = 301

const POLICY: Record<string, RuntimeStatePolicy> = {
  thermo: { durability: 'restored', volatileFields: [], restoredFields: ['last'] },
  plain: { durability: 'restored', volatileFields: [] },
}
const policyFor = (cap: string): RuntimeStatePolicy =>
  POLICY[cap] ?? { durability: 'session', volatileFields: [] }

describe('persistableBlob — restoredFields', () => {
  it('writes only the named fields of a cap that declares them', () => {
    const out = persistableBlob({ thermo: { last: 'heat', mode: 'off', target: 21 } }, policyFor)
    expect(out).toEqual({ thermo: { last: 'heat' } })
  })

  it('a restored cap without the declaration still persists its whole slice', () => {
    const slice = { a: 1, b: 2 }
    expect(persistableBlob({ plain: slice }, policyFor)).toEqual({ plain: slice })
  })

  it('drops the cap altogether when none of the named fields is set', () => {
    expect(persistableBlob({ thermo: { mode: 'off' } }, policyFor)).toEqual({})
  })
})

describe('restoredStateFields across a restart', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('climate-control: only lastActiveMode comes back, mode and temperatures do not', async () => {
    const before = harness(runtimeStatePolicyFor)
    before.mirror.applySingleCapUpdate(DEVICE, 'climate-control', {
      mode: 'heat',
      targetTemperature: 22,
      currentTemperature: 19,
    })
    before.mirror.applySingleCapUpdate(DEVICE, 'climate-control', {
      mode: 'off',
      targetTemperature: 22,
      currentTemperature: 19,
    })
    before.mirror.scheduleRuntimeStateDiskWrite(DEVICE, before.settings, 'climate-control')
    await flushDebounce()
    const onDisk = before.writes.at(-1)?.blob ?? {}
    expect(onDisk).toEqual({ 'climate-control': { lastActiveMode: 'heat' } })

    const after = harness(runtimeStatePolicyFor)
    after.mirror.seedMirror(DEVICE, onDisk)
    expect(after.mirror.capSlice(DEVICE, 'climate-control')).toEqual({ lastActiveMode: 'heat' })
  })

  it('the boot seed keeps only the named fields of a row that carries more', () => {
    const after = harness(policyFor)
    after.mirror.seedMirror(DEVICE, { thermo: { last: 'cool', mode: 'off', target: 18 } })
    expect(after.mirror.capSlice(DEVICE, 'thermo')).toEqual({ last: 'cool' })
  })

  it('a restored cap without the declaration seeds its whole slice', () => {
    const after = harness(policyFor)
    after.mirror.seedMirror(DEVICE, { plain: { a: 1, b: 2 } })
    expect(after.mirror.capSlice(DEVICE, 'plain')).toEqual({ a: 1, b: 2 })
  })
})
