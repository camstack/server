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
import { deviceTextParams } from '../device-directory.js'
import { buildTemplateVars } from '../dispatcher.js'
import { groupWindowSubject } from '../group-window-summary.js'
import type { NcOutboxEntry } from '../outbox.js'
import { NC_SYSTEM_DEVICE_ID } from '../rule-engine.js'
import { NcTextCatalog } from '../text-catalog.js'

const TextsFileSchema = z.record(z.string(), z.unknown())

const IDS = [637, 636, 3830, 617]

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

function summarize(entries: readonly NcOutboxEntry[], language: 'en' | 'it'): string {
  const subject = groupWindowSubject({
    rule: RULE,
    entries,
    texts: new NcTextCatalog({ language }),
    nowMs: 2_000,
    openedAt: 1_000,
    targetId: 't',
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
})
