import { describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import type { NcSystemEventSubject } from '../rule-engine.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deviceDisplayLabel, type NcDeviceIdentity } from '../device-directory.js'
import { deviceTypePhrase } from '../device-type-label.js'
import labels from '../device-type-labels.json' with { type: 'json' }
import { NcTextCatalog } from '../text-catalog.js'
import { stateSummaryText, type NcStateSummary } from '../state-summary/state-summary.js'
import type { NcStateItem } from '../state-summary/state-model.js'

function identity(type: string, name: string): NcDeviceIdentity {
  return { deviceId: 12, type, name, isCamera: type === DeviceType.Camera, parentDeviceId: null }
}

function phraseIn(table: object, type: string): string | undefined {
  if (!Object.hasOwn(table, type)) return undefined
  const value: unknown = Reflect.get(table, type)
  return typeof value === 'string' ? value : undefined
}

function flatCatalog(file: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node === 'string') {
      out[prefix] = node
      return
    }
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    for (const [key, value] of Object.entries(node)) {
      walk(value, prefix.length === 0 ? key : `${prefix}.${key}`)
    }
  }
  walk(JSON.parse(readFileSync(file, 'utf8')), '')
  return out
}

describe('deviceDisplayLabel', () => {
  it('places the translated type after the name', () => {
    const lock = identity(DeviceType.Lock, 'Serratura cucina')
    expect(deviceDisplayLabel(lock, 12, 'it')).toBe('Serratura cucina (Serratura)')
    expect(deviceDisplayLabel(lock, 12, 'en')).toBe('Serratura cucina (Lock)')
    expect(deviceDisplayLabel(identity(DeviceType.Camera, 'Front door'), 12, 'en')).toBe(
      'Front door (Camera)',
    )
  })

  it('keeps the bare name when the type would repeat it, or is not a useful type', () => {
    expect(deviceDisplayLabel(identity(DeviceType.Lock, 'Kitchen Lock'), 12, 'en')).toBe(
      'Kitchen Lock',
    )
    expect(deviceDisplayLabel(identity(DeviceType.Lock, 'Kitchen (Lock)'), 12, 'en')).toBe(
      'Kitchen (Lock)',
    )
    expect(deviceDisplayLabel(identity(DeviceType.Lock, 'Clock'), 12, 'en')).toBe('Clock (Lock)')
    expect(deviceDisplayLabel(identity(DeviceType.Generic, 'Widget'), 12, 'en')).toBe('Widget')
    expect(deviceDisplayLabel(identity(DeviceType.Container, 'Hall'), 12, 'en')).toBe('Hall')
    expect(deviceDisplayLabel(identity('not-a-type', 'Widget'), 12, 'en')).toBe('Widget')
    expect(deviceDisplayLabel(undefined, 12, 'it')).toBe('12')
    expect(deviceDisplayLabel(identity(DeviceType.Lock, '  '), 12, 'it')).toBe('12')
  })

  it('uses the same phrases as the admin device-type catalog', () => {
    const root = fileURLToPath(new URL('../../../../../', import.meta.url))
    const en = flatCatalog(path.join(root, 'packages/addon-admin-ui/src/i18n/en.json'))
    const it = flatCatalog(path.join(root, 'packages/addon-admin-ui/src/i18n/it.json'))
    for (const type of Object.values(DeviceType)) {
      const phrase = deviceTypePhrase(type, 'en')
      const key = Object.keys(en).find((candidate) => {
        const id = candidate.replace(/^uiLibrary\.deviceMeta\.type\./, '')
        if (id === candidate) return false
        const kebab = id.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
        return kebab === type
      })
      expect(key, type).toBeDefined()
      expect(phrase, type).toBe(en[key ?? ''])
      expect(deviceTypePhrase(type, 'it'), type).toBe(it[key ?? ''])
      expect(phraseIn(labels.en, type), type).toBe(phrase)
    }
  })
})

describe('shipped device sentences', () => {
  const vars = {
    deviceName: 'Serratura cucina',
    deviceLabel: 'Serratura cucina (Serratura)',
  }

  it('renders the type in the default text and leaves a deviceName override bare', () => {
    const shipped = new NcTextCatalog({ language: 'it' })
    expect(shipped.text({ key: 'system.device-offline.body', vars })).toBe(
      'Il dispositivo Serratura cucina (Serratura) è offline',
    )
    const overridden = new NcTextCatalog({
      language: 'it',
      overrides: {
        it: { 'system.device-offline.body': 'Il dispositivo {{deviceName}} è offline' },
      },
    })
    expect(overridden.text({ key: 'system.device-offline.body', vars })).toBe(
      'Il dispositivo Serratura cucina è offline',
    )
  })

  it('renders the type on a grouped summary line', () => {
    const texts = new NcTextCatalog({ language: 'it' })
    const subject: NcSystemEventSubject = {
      kind: 'device-offline',
      subject: 'device:12',
      deviceId: 12,
      deviceType: DeviceType.Lock,
      data: {},
    }
    const item: NcStateItem = {
      section: 'device-state',
      subject,
      lineKey: 'summary.line.device-offline',
      params: { deviceName: 'Serratura cucina' },
      since: 1_700_000_000_000,
    }
    const summary: NcStateSummary = {
      sections: [{ id: 'device-state', status: 'read', items: [item] }],
      itemCount: 1,
      unavailableCount: 0,
      dropped: {},
      excludedGroups: [],
    }
    const words = stateSummaryText({ texts, summary, nowMs: item.since ?? 0 })
    expect(words?.text).toContain('Serratura cucina (Serratura)')
  })
})
