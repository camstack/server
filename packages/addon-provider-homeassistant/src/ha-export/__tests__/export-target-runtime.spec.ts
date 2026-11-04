/**
 * The runtime over export targets. A target is a minted id that REFERENCES a Home Assistant
 * connection: the push link is opened under the target id against the connection's credentials;
 * a target whose connection is missing is UNCONFIGURED (pushes nothing, keeps every device) and
 * is never unexposed or pruned; the device-panel key carries the target id.
 *
 * Disarm: bring back `prune` in `refreshBrokers` (delete the records whose connection the list
 * lacks) and "keeps the devices of a target whose connection is missing" fails; resolve the link
 * with the target id instead of the connection id and "opens the link under the target id against
 * the connection" fails; match the patch key against the connection instead of the target and
 * "routes a device-panel key to the named target" fails.
 */
import { type IScopedLogger, makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { HaExportAddon } from '../ha-export.addon.js'
import { ExportTargets, haExportTargetsKind, newTargetBody } from '../target-records.js'

interface Logged {
  readonly level: string
  readonly message: string
  readonly tags: unknown
}

function loggerInto(lines: Logged[]): IScopedLogger {
  const log =
    (level: string) =>
    (message: string, ctx?: { tags?: unknown }): void => {
      lines.push({ level, message, tags: ctx?.tags })
    }
  const logger: IScopedLogger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface BrokerRow {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly addonId: string
}
const HA = (id: string): BrokerRow => ({
  id,
  name: id,
  kind: 'home-assistant',
  addonId: 'provider-homeassistant',
})

async function harness(brokers: readonly BrokerRow[]) {
  const addon = new HaExportAddon()
  const lines: Logged[] = []
  const configReads: unknown[] = []
  const reconciles: string[] = []
  const memory = makeInMemoryRecords('homeassistant-export')
  await memory.records.declare({ 'ha-export-targets': haExportTargetsKind })
  const handle = memory.records.kind(haExportTargetsKind)
  await handle.put({
    id: 'hae_001',
    data: {
      ...newTargetBody('Home'),
      connectionId: 'ha_001',
      devices: ['10', '11'],
    },
  })
  Reflect.set(addon, '_ctx', {
    logger: loggerInto(lines),
    api: {
      broker: {
        list: { query: async () => brokers },
        getBrokerConfig: {
          query: async (input: unknown) => {
            configReads.push(input)
            return { baseUrl: 'http://192.0.2.5:8123', accessToken: 'token' }
          },
        },
      },
    },
  })
  Reflect.set(addon, 'targetBook', await ExportTargets.load(handle))
  Reflect.set(addon, 'reconcile', async (reason: string) => {
    reconciles.push(reason)
  })
  const call = async (name: string, ...args: unknown[]): Promise<unknown> => {
    const fn: unknown = Reflect.get(addon, name)
    if (typeof fn !== 'function') throw new Error(`no ${name}`)
    return fn.call(addon, ...args)
  }
  const dispose = async (): Promise<void> => {
    const links: unknown = Reflect.get(addon, 'links')
    if (!(links instanceof Map)) return
    for (const link of links.values()) await link.client.dispose()
  }
  return { addon, handle, lines, configReads, reconciles, call, dispose }
}

describe('an export target and its connection', () => {
  it('opens the link under the target id against the connection', async () => {
    const h = await harness([HA('ha_001')])
    await h.call('refreshBrokers')
    expect(h.configReads).toEqual([{ id: 'ha_001', addonId: 'provider-homeassistant' }])
    const links: unknown = Reflect.get(h.addon, 'links')
    expect(links instanceof Map ? [...links.keys()] : null).toEqual(['hae_001'])
    expect(Reflect.get(h.addon, 'enabled')).toEqual(['hae_001'])
    await h.dispose()
  })

  it('keeps the devices of a target whose connection is missing, and reports it unconfigured', async () => {
    const h = await harness([HA('ha_other')])
    await h.call('refreshBrokers')
    expect(Reflect.get(h.addon, 'enabled')).toEqual([])
    expect((await h.handle.get('hae_001'))?.data.devices).toEqual(['10', '11'])
    expect(h.configReads).toEqual([])
    const warned = h.lines.find((l) => l.level === 'warn' && /unconfigured/.test(l.message))
    expect(warned).toBeDefined()
    const body = (await h.handle.get('hae_001'))?.data
    expect(await h.call('targetHealth', 'hae_001', body)).toMatchObject({
      state: 'error',
      label: 'Unconfigured',
    })
    const status = await h.call('buildStatus', await h.call('targetScope', 'hae_001'))
    expect(status).toMatchObject({ linkState: 'unlinked' })
    expect(status).toHaveProperty('error')
  })

  it('treats an empty broker list as "not known yet": nothing pruned, nothing unexposed', async () => {
    const h = await harness([])
    await h.call('refreshBrokers')
    expect(Reflect.get(h.addon, 'enabled')).toEqual([])
    expect((await h.handle.get('hae_001'))?.data.devices).toEqual(['10', '11'])
  })

  it('resumes the same devices when the connection appears', async () => {
    const h = await harness([HA('ha_other')])
    await h.call('refreshBrokers')
    expect(Reflect.get(h.addon, 'enabled')).toEqual([])
    Reflect.set(h.addon, '_ctx', {
      ...Reflect.get(h.addon, '_ctx'),
      api: {
        broker: {
          list: { query: async () => [HA('ha_001')] },
          getBrokerConfig: {
            query: async () => ({
              baseUrl: 'http://192.0.2.5:8123',
              accessToken: 'token',
            }),
          },
        },
      },
    })
    await h.call('refreshBrokers')
    expect(Reflect.get(h.addon, 'enabled')).toEqual(['hae_001'])
    expect((await h.handle.get('hae_001'))?.data.devices).toEqual(['10', '11'])
    await h.dispose()
  })
})

describe('the device panel', () => {
  it('offers one switch per enabled target, keyed haExport:<deviceId>:<targetId>', async () => {
    const h = await harness([])
    const contribution = await h.call('buildContribution', 10)
    const keys = JSON.stringify(contribution)
    expect(keys).toContain('haExport:10:hae_001')
    expect(keys).not.toContain('ha_001"')
  })

  it('routes a device-panel key to the named target and refuses an unknown one, tagged by device', async () => {
    const h = await harness([])
    await h.call('applyDeviceSettingsPatch', 12, {
      'haExport:12:hae_001': true,
    })
    expect((await h.handle.get('hae_001'))?.data.devices).toEqual(['10', '11', '12'])
    await h.call('applyDeviceSettingsPatch', 12, {
      'haExport:12:hae_404': true,
    })
    expect(await h.handle.get('hae_404')).toBeNull()
    const warn = h.lines.find((l) => /does not exist/.test(l.message))
    expect(warn?.tags).toEqual({ deviceId: 12 })
    expect(h.reconciles).toEqual(['device-panel'])
  })
})
