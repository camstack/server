import { describe, expect, it } from 'vitest'
import type { HubCall } from '../hub/hub-call.ts'
import { parseArgs, planLocations, runRepair } from '../hub/repair-migration-pair.ts'

function fakeHub(
  outcome: string,
  locations: Record<number, string | null>,
): { hub: HubCall; calls: Array<{ route: string; input: unknown }> } {
  const calls: Array<{ route: string; input: unknown }> = []
  const hub: HubCall = {
    query: async (route, input) => {
      calls.push({ route, input })
      const id = Reflect.get(Object(input), 'deviceId')
      return { location: locations[Number(id)] ?? null }
    },
    mutate: async (route, input) => {
      calls.push({ route, input })
      return { outcome }
    },
  }
  return { hub, calls }
}

const ARGS = parseArgs([
  '--server',
  'h',
  '--a',
  '3628',
  '--b',
  '5920',
  '--location-a',
  'Lavanderia',
  '--location-b',
  'none',
])
if (typeof ARGS === 'string') throw new Error(ARGS)

describe('repair-migration-pair', () => {
  it('refuses without --server or with equal ids', () => {
    expect(parseArgs(['--a', '1', '--b', '2'])).toMatch(/--server/)
    expect(parseArgs(['--server', 'h', '--a', '1', '--b', '1'])).toMatch(/different/)
  })

  it('plans only the numbers whose room differs', () => {
    const plan = planLocations(
      new Map([
        [1, 'A'],
        [2, null],
      ]),
      new Map<number, string | null | undefined>([
        [1, 'A'],
        [2, 'B'],
      ]),
    )
    expect(plan).toEqual([{ deviceId: 2, from: null, to: 'B' }])
  })

  it('dry run writes no location and passes apply:false', async () => {
    const { hub, calls } = fakeHub('would-repair', { 3628: null, 5920: 'Lavanderia' })
    const lines = await runRepair(hub, { ...ARGS, apply: false })
    expect(calls.filter((c) => c.route === 'deviceManager.setLocation')).toEqual([])
    expect(calls[0]?.input).toMatchObject({ apply: false })
    expect(lines.join('\n')).toContain('would set')
  })

  it('apply restores the rooms, and a second run changes nothing', async () => {
    const first = fakeHub('repaired', { 3628: null, 5920: 'Lavanderia' })
    await runRepair(first.hub, { ...ARGS, apply: true })
    expect(first.calls.filter((c) => c.route === 'deviceManager.setLocation')).toEqual([
      { route: 'deviceManager.setLocation', input: { deviceId: 3628, location: 'Lavanderia' } },
      { route: 'deviceManager.setLocation', input: { deviceId: 5920, location: null } },
    ])
    const second = fakeHub('nothing-to-repair', { 3628: 'Lavanderia', 5920: null })
    const lines = await runRepair(second.hub, { ...ARGS, apply: true })
    expect(second.calls.some((c) => c.route === 'deviceManager.setLocation')).toBe(false)
    expect(lines).toContain('location: nothing to change')
  })

  it('a one-sided pair is refused loudly', async () => {
    const { hub } = fakeHub('refused-one-sided', {})
    await expect(runRepair(hub, { ...ARGS, apply: true })).rejects.toThrow(/one side/)
  })
})
