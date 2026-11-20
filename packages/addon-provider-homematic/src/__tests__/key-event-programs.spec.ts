import { describe, expect, it } from 'vitest'
import { deviceKeyEventState, keyEventStatuses } from '../ui/key-event-programs.js'

const channel = (address: string) => ({
  address,
  channelName: null,
  deviceName: null,
  deviceId: null,
})
const program = (name: string, active: boolean, keys: string[]) => ({
  name,
  active,
  channels: keys.map(channel),
})

describe('keyEventStatuses (the dummy-program detection)', () => {
  it('a key referenced by an active program is ok, and names the program', () => {
    const [status] = keyEventStatuses(['D:1'], [program('CamStack: Hall events', true, ['D:1'])])
    expect(status).toEqual({ address: 'D:1', state: 'ok', programs: ['CamStack: Hall events'] })
  })

  it('a key no program references is missing', () => {
    const [status] = keyEventStatuses(['D:1'], [program('Other', true, ['D:2'])])
    expect(status).toEqual({ address: 'D:1', state: 'missing', programs: [] })
  })

  it('no programs at all is missing for every key', () => {
    expect(keyEventStatuses(['D:1', 'D:2'], []).map((s) => s.state)).toEqual(['missing', 'missing'])
  })

  it('a key only a disabled program references is inactive, not ok', () => {
    const [status] = keyEventStatuses(['D:1'], [program('Off', false, ['D:1'])])
    expect(status?.state).toBe('inactive')
    expect(status?.programs).toEqual(['Off'])
  })

  it('names every referencing program, active ones first', () => {
    const [status] = keyEventStatuses(
      ['D:1'],
      [program('B off', false, ['D:1']), program('A on', true, ['D:1'])],
    )
    expect(status?.programs).toEqual(['A on', 'B off'])
    expect(status?.state).toBe('ok')
  })

  it('judges each key on its own', () => {
    const out = keyEventStatuses(['D:1', 'D:2'], [program('P', true, ['D:1'])])
    expect(out.map((s) => s.state)).toEqual(['ok', 'missing'])
  })
})

describe('deviceKeyEventState', () => {
  it('is the worst key, and null for a device without keys', () => {
    expect(deviceKeyEventState([])).toBeNull()
    const ok = { address: 'a', state: 'ok', programs: [] } as const
    const missing = { address: 'b', state: 'missing', programs: [] } as const
    const inactive = { address: 'c', state: 'inactive', programs: [] } as const
    expect(deviceKeyEventState([ok])).toBe('ok')
    expect(deviceKeyEventState([ok, inactive])).toBe('inactive')
    expect(deviceKeyEventState([ok, inactive, missing])).toBe('missing')
  })
})
