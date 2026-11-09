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

  it('the escape payloads P1 refuses are still refused through the host', async () => {
    const [out] = await host.render(["{{ range.constructor('return process')() }}"], undefined)
    expect(out?.ok).toBe(false)
  })

  it('check names the aliases and whether each is allowed', async () => {
    const check = await host.check('{{ garage.temperature }}{{ stufa.temperature }}', new Set([7]))
    expect(check).toEqual({
      ok: true,
      aliases: [
        { alias: 'garage', deviceId: 9, allowed: false },
        { alias: 'stufa', deviceId: 7, allowed: true },
      ],
    })
  })
})
