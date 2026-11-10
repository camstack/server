import { fileURLToPath } from 'node:url'
import type { IScopedLogger } from '@camstack/types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceTemplateHost, type TemplateDeviceRow } from '../template-host.js'
import { DeviceTemplateRenderer } from '../template-renderer.js'

const WORKER = fileURLToPath(new URL('../template-worker.ts', import.meta.url))

const rows: Record<string, TemplateDeviceRow> = {
  stufa: { deviceId: 7, addonId: 'ecowitt', stableId: 's', alias: 'stufa' },
  garage: { deviceId: 9, addonId: 'ecowitt', stableId: 'g', alias: 'garage' },
}
const slices: Record<string, Record<string, unknown>> = {
  '7|temperature-sensor': { temperature: 21.5 },
  '9|temperature-sensor': { temperature: 4 },
}

const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

let renderer: DeviceTemplateRenderer
let host: DeviceTemplateHost
beforeAll(() => {
  renderer = new DeviceTemplateRenderer({
    workerPath: WORKER,
    workerExecArgv: ['--import', 'tsx'],
    budgetMs: 2000,
  })
  host = new DeviceTemplateHost({
    renderer,
    logger,
    findByAlias: async (alias) => rows[alias] ?? null,
    findById: async (id) => Object.values(rows).find((r) => r.deviceId === id) ?? null,
    capsOf: async () => ['temperature-sensor'],
    fetchSlice: async (id, cap) => slices[`${id}|${cap}`] ?? null,
  })
})
afterAll(() => renderer.dispose())

describe('DeviceTemplateHost', () => {
  it('renders against the slices the mirror holds now', async () => {
    const [out] = await host.render(
      ['{{ stufa.temperature | round(0) }} / {{ garage.temperature }}'],
      undefined,
    )
    expect(out).toMatchObject({ ok: true, text: '22 / 4' })
  })

  it('an unknown alias prints the dash and names the reason in the trace', async () => {
    const [out] = await host.render(['{{ ghost.temperature }}'], undefined)
    expect(out).toMatchObject({ ok: true, text: '—' })
    expect(out?.trace[0]).toMatchObject({ reason: 'unknown-alias' })
  })

  it('refuses a template naming a device outside the allowed set, and renders the allowed one', async () => {
    const [bad, good] = await host.render(
      ['{{ garage.temperature }}', '{{ stufa.temperature }}'],
      new Set([7]),
    )
    expect(bad).toMatchObject({ ok: false, refusal: { reason: 'out-of-scope' } })
    expect(good).toMatchObject({ ok: true, text: '21.5' })
  })

  it('a restricted caller gets the same refusal for a missing alias as for one it may not see, resolves each alias once and warns once', async () => {
    const lookups: string[] = []
    const warns: string[] = []
    const counting = new DeviceTemplateHost({
      renderer,
      logger: { ...logger, warn: (m: string) => void warns.push(m) },
      findByAlias: async (alias) => {
        lookups.push(alias)
        return rows[alias] ?? null
      },
      findById: async (id) => Object.values(rows).find((r) => r.deviceId === id) ?? null,
      capsOf: async () => ['temperature-sensor'],
      fetchSlice: async (id, cap) => slices[`${id}|${cap}`] ?? null,
    })
    const out = await counting.render(
      ['{{ garage.temperature }}', '{{ ghost.temperature }}', '{{ stufa.temperature }}'],
      new Set([7]),
    )
    const [hidden, missing, fine] = out
    expect(hidden).toMatchObject({ ok: false, refusal: { reason: 'out-of-scope' } })
    expect(missing).toMatchObject({ ok: false, refusal: { reason: 'out-of-scope' } })
    const shape = (m: string | undefined, alias: string) => m?.replace(alias, '<alias>')
    expect(shape(missing?.ok === false ? missing.refusal.message : undefined, 'ghost')).toBe(
      shape(hidden?.ok === false ? hidden.refusal.message : undefined, 'garage'),
    )
    expect(fine).toMatchObject({ ok: true, text: '21.5' })
    expect([...lookups].sort()).toEqual(['garage', 'ghost', 'stufa'])
    expect(warns).toHaveLength(1)
  })

  it('the escape payloads P1 refuses are still refused through the host', async () => {
    const [out] = await host.render(["{{ range.constructor('return process')() }}"], undefined)
    expect(out?.ok).toBe(false)
  })

  it('check names the aliases and whether each is allowed', async () => {
    const check = await host.check('{{ garage.temperature }}{{ stufa.temperature }}', new Set([7]))
    expect(check).toEqual({
      ok: true,
      aliases: [
        {
          alias: 'garage',
          deviceId: 9,
          allowed: false,
          row: rows['garage'],
          reads: ['temperature'],
        },
        { alias: 'stufa', deviceId: 7, allowed: true, row: rows['stufa'], reads: ['temperature'] },
      ],
      readsClock: false,
    })
  })
})

describe('the clock and the device a render is for (BYS #450 P5)', () => {
  // 2026-11-10 14:05:09 in the SERVER zone, so the expectation is zone independent.
  const at = new Date(2026, 10, 10, 14, 5, 9).getTime()
  let clocked: DeviceTemplateRenderer
  let hostFor: DeviceTemplateHost
  beforeAll(() => {
    clocked = new DeviceTemplateRenderer({
      workerPath: WORKER,
      workerExecArgv: ['--import', 'tsx'],
      budgetMs: 2000,
      now: () => at,
    })
    hostFor = new DeviceTemplateHost({
      renderer: clocked,
      logger,
      findByAlias: async (alias) => rows[alias] ?? null,
      findById: async (id) => Object.values(rows).find((row) => row.deviceId === id) ?? null,
      capsOf: async () => ['temperature-sensor'],
      fetchSlice: async (id, cap) => slices[`${id}|${cap}`] ?? null,
    })
  })
  afterAll(() => clocked.dispose())

  it('now prints the clock in the server zone through time()', async () => {
    const [out] = await hostFor.render(["{{ now | time('HH:mm') }} {{ now | time('DD/MM/YYYY') }}"], undefined)
    expect(out).toMatchObject({ ok: true, text: '14:05 10/11/2026' })
  })

  it('camera is the device the render is for, so one text serves every device', async () => {
    const text = '{{ camera.temperature | round(0) }}'
    const [forStufa] = await hostFor.render([text], undefined, { deviceId: 7 })
    const [forGarage] = await hostFor.render([text], undefined, { deviceId: 9 })
    expect(forStufa).toMatchObject({ ok: true, text: '22' })
    expect(forGarage).toMatchObject({ ok: true, text: '4' })
  })

  it('camera carries the values the caller knows of the device', async () => {
    const [named, empty] = await hostFor.render(
      ["{{ camera.lastPerson | default('') }}|{{ camera.lastPlate }}", "[{{ camera.lastPerson | default('') }}]"],
      undefined,
      { deviceId: 7, values: { lastPerson: 'Mario', lastPlate: 'AB123CD' } },
    )
    expect(named).toMatchObject({ ok: true, text: 'Mario|AB123CD' })
    const [none] = await hostFor.render(["[{{ camera.lastPerson | default('') }}]"], undefined, {
      deviceId: 7,
    })
    expect(none).toMatchObject({ ok: true, text: '[]' })
    expect(empty).toMatchObject({ ok: true, text: '[Mario]' })
  })

  it('camera without a device to render for is an unknown alias, not another device', async () => {
    const [out] = await hostFor.render(['{{ camera.temperature }}'], undefined)
    expect(out).toMatchObject({ ok: true, text: '—' })
    expect(out?.trace[0]).toMatchObject({ reason: 'unknown-alias' })
  })

  it('camera is checked against the allowed set like any device', async () => {
    const [out] = await hostFor.render(['{{ camera.temperature }}'], new Set([9]), { deviceId: 7 })
    expect(out).toMatchObject({ ok: false, refusal: { reason: 'out-of-scope' } })
  })

  it('check names what a text reads: the device, the fields, and the clock', async () => {
    const check = await hostFor.check(
      "{{ camera.temperature }} {{ stufa.temperature_sensor.temperature }} {{ now | time('HH:mm') }}",
      undefined,
      { deviceId: 9 },
    )
    expect(check).toMatchObject({
      ok: true,
      readsClock: true,
      aliases: [
        { alias: 'camera', deviceId: 9, reads: ['temperature'] },
        { alias: 'stufa', deviceId: 7, reads: ['temperature_sensor.temperature'] },
      ],
    })
  })
})
