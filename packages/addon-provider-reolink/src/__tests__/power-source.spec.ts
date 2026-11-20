import type { BatteryPowerSourceMode, SwitchPowerSourceResult } from '@apocaliss92/nodelink-js'
import { describe, expect, it, vi } from 'vitest'
import {
  type PowerSourceApi,
  type PowerSourceTarget,
  readPowerSource,
  switchPowerSourceTo,
} from '../power-source.js'
import { createRecordingLogger, type RecordedLine } from './clip-test-logger.js'

interface FakeApiOptions {
  /** Successive answers to `getPowerSource`; a thrown Error stands for a failed read. */
  readonly reads: readonly (BatteryPowerSourceMode | undefined | Error)[]
  readonly supported?: boolean
  readonly switchResult?: SwitchPowerSourceResult
  readonly switchThrows?: Error
}

function buildTarget(options: FakeApiOptions): {
  readonly target: PowerSourceTarget
  readonly switchSpy: ReturnType<typeof vi.fn>
  readonly probeSpy: ReturnType<typeof vi.fn>
  readonly lines: () => readonly RecordedLine[]
} {
  const reads = [...options.reads]
  const switchSpy = vi.fn(async (): Promise<SwitchPowerSourceResult> => {
    if (options.switchThrows) throw options.switchThrows
    return options.switchResult ?? { mode: 'adapter', dryRun: false, accepted: true }
  })
  const probeSpy = vi.fn(async () => options.supported ?? true)
  const api: PowerSourceApi = {
    getPowerSource: async () => {
      const next = reads.shift()
      if (next instanceof Error) throw next
      return next
    },
    probePowerSourceSwitchSupport: probeSpy,
    switchPowerSource: switchSpy,
  }
  const logger = createRecordingLogger()
  const lines = (): readonly RecordedLine[] => [...logger.infos, ...logger.warns]
  return { target: { api, channel: 2, deviceId: 3628, logger }, switchSpy, probeSpy, lines }
}

describe('readPowerSource', () => {
  it('reports the mode the camera states', async () => {
    const { target } = buildTarget({ reads: ['adapter'] })
    expect(await readPowerSource(target)).toBe('adapter')
  })

  it('reports unknown, never battery, when the read fails', async () => {
    const { target, lines } = buildTarget({ reads: [new Error('timeout')] })
    expect(await readPowerSource(target)).toBe('unknown')
    expect(lines().every((l) => l.extras.tags?.deviceId === 3628)).toBe(true)
    expect(lines().length).toBeGreaterThan(0)
  })

  it('reports unknown when the firmware is silent', async () => {
    const { target } = buildTarget({ reads: [undefined] })
    expect(await readPowerSource(target)).toBe('unknown')
  })
})

describe('switchPowerSourceTo', () => {
  it('dry-runs, sends once on the camera channel, reads back and reports before/after', async () => {
    const { target, switchSpy, probeSpy, lines } = buildTarget({ reads: ['battery', 'adapter'] })
    const out = await switchPowerSourceTo(target, 'adapter')
    expect(out).toEqual({
      outcome: 'sent',
      mode: 'adapter',
      accepted: true,
      before: 'battery',
      after: 'adapter',
      applied: true,
    })
    expect(probeSpy).toHaveBeenCalledWith('adapter', { channel: 2 })
    expect(switchSpy).toHaveBeenCalledTimes(1)
    expect(switchSpy).toHaveBeenCalledWith('adapter', { channel: 2 })
    expect(lines().length).toBeGreaterThan(1)
    expect(lines().every((l) => l.extras.tags?.deviceId === 3628)).toBe(true)
  })

  it('refuses with the reason and sends no real switch when the dry run is refused', async () => {
    const { target, switchSpy } = buildTarget({ reads: ['battery'], supported: false })
    const out = await switchPowerSourceTo(target, 'adapter')
    expect(out).toEqual({
      outcome: 'refused',
      mode: 'adapter',
      reason: 'dry-run-refused',
      before: 'battery',
    })
    expect(switchSpy).not.toHaveBeenCalled()
  })

  it('reports an accepted switch whose read-back still says battery as not applied', async () => {
    const { target, switchSpy } = buildTarget({ reads: ['battery', 'battery'] })
    const out = await switchPowerSourceTo(target, 'adapter')
    expect(out).toEqual({
      outcome: 'sent',
      mode: 'adapter',
      accepted: true,
      before: 'battery',
      after: 'battery',
      applied: false,
    })
    expect(switchSpy).toHaveBeenCalledTimes(1)
  })

  it('reads back unknown, not battery, when the verification read fails', async () => {
    const { target } = buildTarget({ reads: ['battery', new Error('asleep')] })
    const out = await switchPowerSourceTo(target, 'adapter')
    expect(out).toMatchObject({ outcome: 'sent', after: 'unknown', applied: false })
  })

  it('never retries a write that threw', async () => {
    const { target, switchSpy } = buildTarget({
      reads: ['battery'],
      switchThrows: new Error('socket closed'),
    })
    const out = await switchPowerSourceTo(target, 'adapter')
    expect(out).toEqual({
      outcome: 'failed',
      mode: 'adapter',
      error: 'socket closed',
      before: 'battery',
    })
    expect(switchSpy).toHaveBeenCalledTimes(1)
  })

  it('serves the twin direction with the same implementation', async () => {
    const { target, switchSpy } = buildTarget({
      reads: ['adapter', 'battery'],
      switchResult: { mode: 'battery', dryRun: false, accepted: true },
    })
    const out = await switchPowerSourceTo(target, 'battery')
    expect(out).toMatchObject({ outcome: 'sent', mode: 'battery', applied: true })
    expect(switchSpy).toHaveBeenCalledWith('battery', { channel: 2 })
  })
})
