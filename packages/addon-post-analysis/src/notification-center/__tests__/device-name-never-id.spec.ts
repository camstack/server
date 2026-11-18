/**
 * A notification never names a device by its numeric id. A device the
 * directory could not name at intake freezes NO name; every render path words a
 * localized generic label instead.
 */
import { readFileSync } from 'node:fs'
import {
  DeviceType,
  NcRuleInputSchema,
  NcRuleSchema,
  NcSystemEventKindSchema,
  type NcSystemEventKind,
} from '@camstack/types'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  deviceTextParams,
  NcDeviceDirectory,
  type NcDeviceNameResolver,
} from '../device-directory.js'
import { buildTemplateVars, notificationDeviceName } from '../dispatcher.js'
import { groupWindowSubject } from '../group-window-summary.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import type { NcOutboxEntry } from '../outbox.js'
import { NC_SYSTEM_DEVICE_ID } from '../rule-engine.js'
import { NcTextCatalog } from '../text-catalog.js'

const TextsFileSchema = z.record(z.string(), z.unknown())

const IDS = [637, 636, 3830, 617]
const NAMES = new Map(IDS.map((id) => [id, `Videocamera ${id - 600}x`]))

const RULE = NcRuleSchema.parse({
  ...NcRuleInputSchema.parse({
    name: 'Devices',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds: ['stream-offline'] } },
    targets: [{ targetId: 'zentik-1' }],
  }),
  id: 'r',
  createdBy: 'admin',
  createdAt: 1,
  updatedAt: 1,
})

function row(
  kind: NcSystemEventKind,
  deviceId: number,
  textParams: Readonly<Record<string, string>>,
): NcOutboxEntry {
  return {
    id: `r:${kind}:${deviceId}`,
    ruleId: 'r',
    targetId: 't',
    deviceId: NC_SYSTEM_DEVICE_ID,
    recordKind: 'system-event',
    recordId: `ev-${deviceId}`,
    trackId: 'x',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
    updatedAt: 1,
    payload: {
      ruleName: 'Devices',
      delivery: 'system-event',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: NC_SYSTEM_DEVICE_ID,
        className: 'system',
        zones: [],
        timestamp: 1_000,
        systemEvent: {
          kind,
          subject: `stream:${deviceId}`,
          bodyKey: `system.${kind}.body`,
          deviceId,
          deviceType: DeviceType.Camera,
          textParams,
          data: {},
        },
      },
    },
  }
}

function summarize(
  entries: readonly NcOutboxEntry[],
  language: 'en' | 'it',
  resolveName?: NcDeviceNameResolver,
): string {
  const subject = groupWindowSubject({
    rule: RULE,
    entries,
    texts: new NcTextCatalog({ language }),
    nowMs: 2_000,
    openedAt: 1_000,
    targetId: 't',
    ...(resolveName !== undefined ? { resolveName } : {}),
  })
  return JSON.stringify(subject?.systemEvent?.textParams ?? {})
}

describe('a notification never carries the device id', () => {
  it('an unresolved device freezes no name at intake', () => {
    expect(deviceTextParams(637, undefined)['deviceName']).toBeUndefined()
  })

  it.each([
    'en',
    'it',
  ] as const)('%s: a grouped stream-offline window words a generic label', (language) => {
    const text = summarize(
      IDS.map((id) => row('stream-offline', id, deviceTextParams(id, undefined))),
      language,
    )
    expect(text.length).toBeGreaterThan(10)
    for (const id of IDS) expect(text).not.toContain(String(id))
  })

  it('a row an older intake froze with the bare id is treated as unnamed', () => {
    const text = summarize(
      [row('stream-offline', 637, { deviceId: '637', deviceName: '637' })],
      'it',
    )
    expect(text).not.toContain('637')
  })

  it.each([
    'en',
    'it',
  ] as const)('%s: every system title and body renders without the id', (language) => {
    const texts = new NcTextCatalog({ language })
    const file = new URL(`../texts/${language}.json`, import.meta.url)
    const keys = Object.keys(TextsFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))).filter(
      (k) => /^system\.[a-z-]+\.(title|body)/.test(k),
    )
    expect(keys.length).toBeGreaterThan(20)
    for (const key of keys) {
      const parsed = NcSystemEventKindSchema.safeParse(key.split('.')[1])
      // A key of a legacy or non-event family has no kind to build a row for.
      const kind = parsed.success ? parsed.data : 'device-offline'
      const entry = row(kind, 637, deviceTextParams(637, undefined))
      const out = texts.text({ key, vars: buildTemplateVars(texts, entry, 'x', []), count: 1 })
      expect(out, key).not.toContain('637')
    }
  })

  it('cold at intake, warm at render: the summary lists the real names', () => {
    const entries = IDS.map((id) => row('stream-offline', id, deviceTextParams(id, undefined)))
    const text = summarize(entries, 'it', (id) => NAMES.get(id))
    for (const id of IDS) {
      expect(text).toContain(NAMES.get(id))
      expect(text).not.toContain(String(id))
    }
    expect(text).not.toContain('senza nome')
  })

  it('without the lookup the same rows word the unnamed label (the lookup is what names them)', () => {
    const entries = IDS.map((id) => row('stream-offline', id, deviceTextParams(id, undefined)))
    expect(summarize(entries, 'it')).toContain('senza nome')
  })

  it('a cold directory is warmed once, bounded, by ensureWarm', async () => {
    const calls: number[] = []
    const directory = new NcDeviceDirectory({
      logger: makeSilentLogger(),
      listDevices: async () => {
        calls.push(1)
        return [{ deviceId: 637, type: DeviceType.Camera, name: 'Cortile', isCamera: true }]
      },
    })
    expect(directory.displayName(637)).toBeUndefined()
    expect(await directory.ensureWarm(1_000)).toBe(true)
    expect(directory.displayName(637)).toBe('Cortile')
    await directory.ensureWarm(1_000)
    expect(calls).toHaveLength(1)
  })

  it('the dispatcher names a device from the directory when its own lookup has none', async () => {
    const entry = row('stream-offline', 637, deviceTextParams(637, undefined))
    const none = async (): Promise<null> => null
    expect(await notificationDeviceName(entry, none, 'en', (id) => NAMES.get(id))).toBe(
      NAMES.get(637),
    )
    expect(await notificationDeviceName(entry, none, 'en')).toBe('(unnamed)')
  })
})
