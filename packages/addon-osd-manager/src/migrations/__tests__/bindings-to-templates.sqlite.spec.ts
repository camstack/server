/**
 * Slot bindings and named templates onto the device-template engine, on real SQLite in the
 * canonical `addon-settings` / `addon-device-settings` layout. What the old renderer put on the
 * camera is what the hub's template renderer now puts there (the expected strings below are the
 * old renderer's output, written down before the migration ran), the schedule and gate of a slot
 * survive, a neighbour's rows are untouched, and a second run changes nothing.
 */
import { fileURLToPath } from 'node:url'
import type { DeviceTemplateView } from '@camstack/types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceTemplateRenderer } from '../../../../system/src/builtins/device-manager/device-template/template-renderer.js'
import { settingsFixture } from '../../../../system/src/builtins/sqlite-storage/__tests__/support/addon-settings-fixture.js'
import {
  ADDON_MIGRATIONS,
  BINDINGS_TO_TEMPLATES_MIGRATION_ID,
  type OsdManagerMigrationPorts,
} from '../index.js'

const OWNER = 'osd-manager'
const CAMERA = 101
const GARAGE = 7
const WORKER = fileURLToPath(
  new URL(
    '../../../../system/src/builtins/device-manager/device-template/template-worker.ts',
    import.meta.url,
  ),
)
const NOW = new Date(2026, 10, 10, 9, 5, 20).getTime()

/** The state each device mirrors; the unit the temperature is stored in (D944) is °C. */
const SLICES: Record<number, Record<string, unknown>> = {
  [GARAGE]: {
    'temperature-sensor': { temperature: 20 },
    'humidity-sensor': { humidity: 55, unit: '%' },
    switch: { on: true },
  },
  [CAMERA]: { motion: { detected: true }, values: { lastPerson: 'Anna', lastPlate: '' } },
}

const SCHEDULE = { windows: [{ days: [1, 2], startMinute: 60, endMinute: 120 }] }
const CONDITIONS = { deviceState: { deviceId: GARAGE, states: ['on'] } }

const LEGACY_TEMPLATES = [
  {
    id: 'garage',
    name: 'Garage',
    bindings: [
      {
        alias: 't',
        pick: { deviceId: GARAGE },
        capName: 'temperature-sensor',
        valuePath: 'temperature',
        displayUnit: '°C',
        maxDecimals: 1,
      },
      {
        alias: 'h',
        pick: { deviceId: GARAGE },
        capName: 'humidity-sensor',
        valuePath: 'humidity',
        maxDecimals: 0,
      },
      {
        alias: 's',
        pick: { deviceId: GARAGE },
        capName: 'switch',
        valuePath: 'on',
        maxDecimals: 1,
        valueMap: { true: 'OPEN', false: 'CLOSED' },
      },
    ],
    parser: '{t.full} ({h.full}) {s} {t.value} {t.unit}',
  },
]

const LEGACY_SLOTS = {
  'text-1': {
    enabled: true,
    source: { kind: 'device-state', capName: 'motion', valuePath: 'detected' },
    template: '[${value}]',
    maxDecimals: 1,
    valueMap: { true: 'MOTION', false: '' },
    schedule: SCHEDULE,
    conditions: CONDITIONS,
  },
  'text-2': {
    enabled: true,
    source: { kind: 'clock', pattern: 'HH:mm' },
    template: '${value}',
    maxDecimals: 1,
  },
  'text-3': {
    enabled: false,
    source: { kind: 'latest-recognition', recognition: 'person' },
    template: 'Who: ${value}',
    maxDecimals: 1,
  },
  'text-4': {
    enabled: true,
    source: {
      kind: 'device-state',
      deviceId: GARAGE,
      capName: 'temperature-sensor',
      valuePath: 'temperature',
      displayUnit: '°F',
    },
    template: '${value}${unit}',
    maxDecimals: 0,
  },
  'text-5': {
    enabled: true,
    source: { kind: 'static', text: 'GATE' },
    template: '${value}',
    maxDecimals: 1,
  },
  'text-6': {
    enabled: true,
    source: { kind: 'template', templateId: 'garage' },
    template: '${value}',
    maxDecimals: 1,
  },
}

/** What the OLD renderer wrote for each of the above, from the same state. */
const OLD_OUTPUT: Record<string, string> = {
  'text-1': '[MOTION]',
  'text-2': '09:05',
  'text-3': 'Who: Anna',
  'text-4': '68°F',
  'text-5': 'GATE',
  'text-6': '20°C (55%) OPEN 20 °C',
}

function view(deviceId: number): DeviceTemplateView {
  return {
    deviceId,
    addonId: 'a',
    stableId: String(deviceId),
    slices: SLICES[deviceId] ?? {},
    unitOf: (cap, field) =>
      cap === 'temperature-sensor' && field[0] === 'temperature' ? '°C' : undefined,
  }
}

let renderer: DeviceTemplateRenderer
beforeAll(() => {
  renderer = new DeviceTemplateRenderer({
    workerPath: WORKER,
    workerExecArgv: ['--import', 'tsx'],
    budgetMs: 4000,
    now: () => NOW,
  })
})
afterAll(() => renderer.dispose())

async function migrated() {
  const notes: string[] = []
  const f = settingsFixture<OsdManagerMigrationPorts>({
    addonId: OWNER,
    catalogue: ADDON_MIGRATIONS,
    seed: { namedTemplates: LEGACY_TEMPLATES, tickSeconds: 10 },
    neighbour: 'keep-me',
    deviceSeed: { [String(CAMERA)]: { slotBindings: LEGACY_SLOTS } },
    ports: (rows) => ({
      readStored: rows.readStored,
      listDeviceIds: async () => [CAMERA],
      readDeviceField: rows.readDeviceField,
      readAliases: async () => new Map([[GARAGE, 'garage']]),
      readSlice: async (deviceId, capName) => SLICES[deviceId]?.[capName],
      note: (message) => void notes.push(message),
    }),
  })
  return { f, notes }
}

const value = (row: Record<string, unknown> | undefined): unknown => row?.['value']

async function renderedSlots(
  f: Awaited<ReturnType<typeof migrated>>['f'],
): Promise<Record<string, string>> {
  const templates = value(f.rows()[`${OWNER}.namedTemplates`])
  const bindings = value(f.deviceRows()[`${OWNER}:${CAMERA}.slotBindings`])
  if (!Array.isArray(templates) || typeof bindings !== 'object' || bindings === null) {
    throw new Error('the stores did not survive')
  }
  const textOf = new Map<string, string>(
    templates.flatMap((t: unknown) =>
      typeof t === 'object' && t !== null && 'id' in t && 'text' in t
        ? [[String(t.id), String(t.text)] as const]
        : [],
    ),
  )
  const out: Record<string, string> = {}
  for (const [slotId, slot] of Object.entries(bindings)) {
    const source =
      typeof slot === 'object' && slot !== null && 'source' in slot ? slot.source : null
    if (typeof source !== 'object' || source === null || !('kind' in source)) continue
    if (source.kind === 'static' && 'text' in source) out[slotId] = String(source.text)
    if (source.kind === 'template' && 'templateId' in source) {
      const text = textOf.get(String(source.templateId))
      if (text === undefined) throw new Error(`slot ${slotId} points at a missing template`)
      const render = await renderer.render(text, {
        viewOf: (alias) =>
          alias === 'garage' ? view(GARAGE) : alias === 'camera' ? view(CAMERA) : undefined,
      })
      out[slotId] = render.ok ? render.text : `REFUSED ${render.refusal.message}`
    }
  }
  return out
}

describe('osd-manager bindings-to-templates', () => {
  it('renders every marked slot and named template exactly as the old renderer did', async () => {
    const { f } = await migrated()
    const report = await f.boot()
    expect(report.failed).toEqual([])
    expect(report.applied).toContain(BINDINGS_TO_TEMPLATES_MIGRATION_ID)
    expect(await renderedSlots(f)).toEqual(OLD_OUTPUT)
  })

  it('leaves no retired field, keeps the schedule and the gate, and touches no neighbour', async () => {
    const { f } = await migrated()
    await f.boot()
    const bindings = value(f.deviceRows()[`${OWNER}:${CAMERA}.slotBindings`])
    expect(JSON.stringify(bindings)).not.toMatch(
      /"(template|maxDecimals|valueMap)":|"kind":"(clock|latest-recognition|device-state)"/,
    )
    expect(bindings).toMatchObject({
      'text-1': { enabled: true, schedule: SCHEDULE, conditions: CONDITIONS },
    })
    expect(bindings).toMatchObject({ 'text-3': { enabled: false } })
    expect(JSON.stringify(value(f.rows()[`${OWNER}.namedTemplates`]))).not.toMatch(
      /"(parser|bindings)":/,
    )
    expect(value(f.rows()[`${OWNER}.tickSeconds`])).toBe(10)
    expect(value(f.rows()['other-addon.namedTemplates'])).toBe('keep-me')
    expect(value(f.deviceRows()[`other-addon:${CAMERA}.slotBindings`])).toBe('keep-me')
  })

  it('writes a copyable camera for this-camera sources and the alias for another device', async () => {
    const { f } = await migrated()
    await f.boot()
    const text = JSON.stringify(value(f.rows()[`${OWNER}.namedTemplates`]))
    expect(text).toContain('camera.motion.detected')
    expect(text).toContain('garage.temperature_sensor.temperature')
    expect(text).not.toContain(`device_${GARAGE}`)
  })

  it('is a no-op on a second run and on an install that never stored a binding', async () => {
    const { f } = await migrated()
    await f.boot()
    const once = JSON.stringify([f.rows(), f.deviceRows()])
    const second = await f.boot()
    expect(second.failed).toEqual([])
    expect(JSON.stringify([f.rows(), f.deviceRows()])).toBe(once)

    const empty = settingsFixture<OsdManagerMigrationPorts>({
      addonId: OWNER,
      catalogue: ADDON_MIGRATIONS,
      seed: { tickSeconds: 10 },
      neighbour: 'keep-me',
      ports: (rows) => ({
        readStored: rows.readStored,
        listDeviceIds: async () => [],
        readDeviceField: rows.readDeviceField,
        readAliases: async () => new Map(),
        readSlice: async () => undefined,
        note: () => undefined,
      }),
    })
    const before = JSON.stringify(empty.rows())
    await empty.boot()
    expect(JSON.stringify(empty.rows())).toBe(before)
  })

  it('says so when a clock zone cannot be kept, and when a device has no alias', async () => {
    const notes: string[] = []
    const f = settingsFixture<OsdManagerMigrationPorts>({
      addonId: OWNER,
      catalogue: ADDON_MIGRATIONS,
      seed: {},
      neighbour: 'keep-me',
      deviceSeed: {
        [String(CAMERA)]: {
          slotBindings: {
            'text-1': {
              enabled: true,
              source: { kind: 'clock', pattern: 'HH:mm', timezone: 'Asia/Tokyo' },
              template: '${value}',
              maxDecimals: 1,
            },
            'text-2': {
              enabled: true,
              source: {
                kind: 'device-state',
                deviceId: 55,
                capName: 'motion',
                valuePath: 'detected',
              },
              template: '${value}',
              maxDecimals: 1,
            },
          },
        },
      },
      ports: (rows) => ({
        readStored: rows.readStored,
        listDeviceIds: async () => [CAMERA],
        readDeviceField: rows.readDeviceField,
        readAliases: async () => new Map(),
        readSlice: async () => undefined,
        note: (message) => void notes.push(message),
      }),
    })
    await f.boot()
    expect(notes.some((n) => n.includes('Asia/Tokyo'))).toBe(true)
    expect(notes.some((n) => n.includes('device 55 has no alias'))).toBe(true)
  })
})
