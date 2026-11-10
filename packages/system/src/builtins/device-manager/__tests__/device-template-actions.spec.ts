import { fileURLToPath } from 'node:url'
import type { IScopedLogger } from '@camstack/types'
import { afterAll, describe, expect, it } from 'vitest'
import { DeviceTemplateActions } from '../device-template-actions.js'
import { DeviceTemplateRenderer } from '../device-template/template-renderer.js'

const WORKER = fileURLToPath(new URL('../device-template/template-worker.ts', import.meta.url))
const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

const actions = new DeviceTemplateActions(
  logger,
  {
    findByAlias: async (alias) =>
      alias === 'stufa' ? { deviceId: 7, addonId: 'a', stableId: 's', alias } : null,
    findById: async (deviceId) =>
      deviceId === 7 ? { deviceId: 7, addonId: 'a', stableId: 's', alias: 'stufa' } : null,
    capsOf: async () => ['temperature-sensor'],
    fetchSlice: async () => ({ temperature: 21.5 }),
  },
  () =>
    new DeviceTemplateRenderer({
      workerPath: WORKER,
      workerExecArgv: ['--import', 'tsx'],
      budgetMs: 2000,
    }),
)
afterAll(() => actions.dispose())

describe('DeviceTemplateActions', () => {
  it('render answers index-aligned results and honours allowedDeviceIds', async () => {
    const out = await actions.render({
      templates: ['{{ stufa.temperature }}', '{{ stufa.temperature }}'],
      allowedDeviceIds: [],
    })
    expect(out.results.map((r) => r.ok)).toEqual([false, false])
    const open = await actions.render({ templates: ['{{ stufa.temperature }}'] })
    expect(open.results[0]).toMatchObject({ ok: true, text: '21.5' })
  })

  it('thisDevice reaches the host: camera is that device and its values ride along', async () => {
    const out = await actions.render({
      templates: ["{{ camera.temperature }} {{ camera.lastPerson | default('-') }}"],
      thisDevice: { deviceId: 7, values: { lastPerson: 'Mario' } },
    })
    expect(out.results[0]).toMatchObject({ ok: true, text: '21.5 Mario' })
    const checked = await actions.check({
      templates: ['{{ camera.temperature }}'],
      thisDevice: { deviceId: 7 },
    })
    expect(checked.results[0]).toMatchObject({ ok: true, aliases: [{ alias: 'camera', deviceId: 7 }] })
  })

  it('check names the aliases, or the syntax refusal', async () => {
    const out = await actions.check({
      templates: ['{{ stufa.x }}', '{% import "x" %}'],
      allowedDeviceIds: [7],
    })
    expect(out.results[0]).toEqual({
      ok: true,
      aliases: [{ alias: 'stufa', deviceId: 7, allowed: true, reads: ['x'] }],
      readsClock: false,
    })
    expect(out.results[1]).toMatchObject({ ok: false })
  })
})
