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
  CAMERA,
  CONDITIONS,
  GARAGE,
  LEGACY_SLOTS,
  LEGACY_TEMPLATES,
  SCHEDULE,
} from '../__fixtures__/seed.js'
import {
  ADDON_MIGRATIONS,
  BINDINGS_TO_TEMPLATES_MIGRATION_ID,
  type OsdManagerMigrationPorts,
} from '../index.js'

const OWNER = 'osd-manager'
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
        note: (message) => void notes.push(message),
      }),
    })
    await f.boot()
    expect(notes.some((n) => n.includes('Asia/Tokyo'))).toBe(true)
    expect(notes.some((n) => n.includes('device 55 has no alias'))).toBe(true)
  })

  describe('one bad row never blocks the rest', () => {
    const OTHER = 202
    const GOOD_SLOT = {
      enabled: true,
      source: {
        kind: 'device-state',
        deviceId: GARAGE,
        capName: 'humidity-sensor',
        valuePath: 'humidity',
      },
      template: '${value}%',
      maxDecimals: 0,
    }

    function fixture(input: {
      readonly templates?: readonly unknown[]
      readonly bindings: Record<number, Record<string, unknown>>
      readonly aliases?: ReadonlyMap<number, string>
      readonly notes: { message: string; deviceId?: number }[]
    }) {
      return settingsFixture<OsdManagerMigrationPorts>({
        addonId: OWNER,
        catalogue: ADDON_MIGRATIONS,
        seed: input.templates === undefined ? {} : { namedTemplates: input.templates },
        neighbour: 'keep-me',
        deviceSeed: Object.fromEntries(
          Object.entries(input.bindings).map(([id, slots]) => [id, { slotBindings: slots }]),
        ),
        ports: (rows) => ({
          readStored: rows.readStored,
          listDeviceIds: async () => Object.keys(input.bindings).map(Number),
          readDeviceField: rows.readDeviceField,
          readAliases: async () => input.aliases ?? new Map([[GARAGE, 'garage']]),
          note: (message, deviceId) =>
            void input.notes.push({ message, ...(deviceId === undefined ? {} : { deviceId }) }),
        }),
      })
    }

    const slotsOf = (f: ReturnType<typeof fixture>, camera: number): Record<string, unknown> => {
      const row = value(f.deviceRows()[`${OWNER}:${camera}.slotBindings`])
      if (typeof row !== 'object' || row === null) throw new Error('no bindings stored')
      return { ...row }
    }

    it('sets a slot over the bound aside, names it, and migrates the other cameras', async () => {
      const notes: { message: string; deviceId?: number }[] = []
      const f = fixture({
        notes,
        bindings: {
          [CAMERA]: {
            'text-1': { ...GOOD_SLOT, template: 'x'.repeat(1100) + '${value}' },
            'text-2': GOOD_SLOT,
          },
          [OTHER]: { 'text-1': GOOD_SLOT },
        },
      })
      const report = await f.boot()
      expect(report.failed).toEqual([])
      expect(report.applied).toContain(BINDINGS_TO_TEMPLATES_MIGRATION_ID)
      const bad = slotsOf(f, CAMERA)['text-1']
      expect(bad).toEqual({ enabled: false, source: { kind: 'none' } })
      expect(slotsOf(f, CAMERA)['text-2']).toMatchObject({
        enabled: true,
        source: { kind: 'template' },
      })
      expect(slotsOf(f, OTHER)['text-1']).toMatchObject({ source: { kind: 'template' } })
      const named = notes.find((n) => n.message.includes('text-1'))
      expect(named?.deviceId).toBe(CAMERA)
      expect(named?.message).toContain('1024')
    })

    it('sets a malformed slot aside, names it, and migrates the others', async () => {
      const notes: { message: string; deviceId?: number }[] = []
      const f = fixture({
        notes,
        bindings: {
          [CAMERA]: {
            'text-1': { enabled: 'yes', source: 42, maxDecimals: 'lots', template: 7 },
            'text-2': GOOD_SLOT,
          },
        },
      })
      const report = await f.boot()
      expect(report.failed).toEqual([])
      expect(slotsOf(f, CAMERA)['text-1']).toEqual({ enabled: false, source: { kind: 'none' } })
      expect(slotsOf(f, CAMERA)['text-2']).toMatchObject({ source: { kind: 'template' } })
      expect(notes.some((n) => n.message.includes('"text-1"') && n.deviceId === CAMERA)).toBe(true)
      // a rerun finds nothing legacy left
      const once = JSON.stringify(f.deviceRows())
      await f.boot()
      expect(JSON.stringify(f.deviceRows())).toBe(once)
    })

    it('keeps the id and name of a named template it cannot convert, with no text', async () => {
      const notes: { message: string; deviceId?: number }[] = []
      const f = fixture({
        notes,
        templates: [
          { id: 'huge', name: 'Huge', bindings: [], parser: 'y'.repeat(1100) },
          { id: 'broken', name: 'Broken', bindings: 'nope', parser: '{a}' },
          { id: 'fine', name: 'Fine', bindings: [], parser: 'plain' },
        ],
        bindings: { [CAMERA]: { 'text-1': GOOD_SLOT } },
      })
      const report = await f.boot()
      expect(report.failed).toEqual([])
      const templates = value(f.rows()[`${OWNER}.namedTemplates`])
      expect(templates).toEqual(
        expect.arrayContaining([
          { id: 'huge', name: 'Huge', text: '' },
          { id: 'broken', name: 'Broken', text: '' },
          { id: 'fine', name: 'Fine', text: 'plain' },
        ]),
      )
      expect(notes.some((n) => n.message.includes('"Huge"'))).toBe(true)
      expect(notes.some((n) => n.message.includes('"Broken"'))).toBe(true)
    })
  })

  describe('the expression does not depend on the live value', () => {
    const THERMO = {
      enabled: true,
      source: {
        kind: 'device-state',
        deviceId: GARAGE,
        capName: 'humidity-sensor',
        valuePath: 'humidity',
      },
      template: '${value}${unit}',
      maxDecimals: 1,
    }

    async function textOf(
      f: ReturnType<typeof settingsFixture<OsdManagerMigrationPorts>>,
    ): Promise<string> {
      const templates = value(f.rows()[`${OWNER}.namedTemplates`])
      if (!Array.isArray(templates)) throw new Error('no templates')
      const first: unknown = templates[0]
      if (typeof first !== 'object' || first === null || !('text' in first))
        throw new Error('no text')
      return String(first.text)
    }

    async function renderWith(text: string, humidity: unknown): Promise<string> {
      const out = await renderer.render(text, {
        viewOf: (alias) =>
          alias === 'garage'
            ? { ...view(GARAGE), slices: { 'humidity-sensor': { humidity } } }
            : undefined,
      })
      return out.ok ? out.text : `REFUSED ${out.refusal.message}`
    }

    it('prints a number, a 0/1, a string and a boolean the way the old formatter did, device offline at migration', async () => {
      const f = settingsFixture<OsdManagerMigrationPorts>({
        addonId: OWNER,
        catalogue: ADDON_MIGRATIONS,
        seed: {},
        neighbour: 'keep-me',
        deviceSeed: { [String(CAMERA)]: { slotBindings: { 'text-1': THERMO } } },
        ports: (rows) => ({
          readStored: rows.readStored,
          listDeviceIds: async () => [CAMERA],
          readDeviceField: rows.readDeviceField,
          // The device is offline: the migration is given no way to read its state at all.
          readAliases: async () => new Map([[GARAGE, 'garage']]),
          note: () => undefined,
        }),
      })
      expect((await f.boot()).failed).toEqual([])
      const text = await textOf(f)
      expect(await renderWith(text, 1)).toMatch(/^1\b/)
      expect(await renderWith(text, 0)).toMatch(/^0\b/)
      expect(await renderWith(text, 'high')).toMatch(/^high/)
      expect(await renderWith(text, true)).toMatch(/^ON/)
      expect(await renderWith(text, false)).toMatch(/^OFF/)
    })

    it('truncates like the old formatter, never rounds (19.99 -> 19.9, 21.96 -> 21.9)', async () => {
      const f = settingsFixture<OsdManagerMigrationPorts>({
        addonId: OWNER,
        catalogue: ADDON_MIGRATIONS,
        seed: {},
        neighbour: 'keep-me',
        deviceSeed: {
          [String(CAMERA)]: { slotBindings: { 'text-1': { ...THERMO, template: '${value}' } } },
        },
        ports: (rows) => ({
          readStored: rows.readStored,
          listDeviceIds: async () => [CAMERA],
          readDeviceField: rows.readDeviceField,
          readAliases: async () => new Map([[GARAGE, 'garage']]),
          note: () => undefined,
        }),
      })
      await f.boot()
      const text = await textOf(f)
      expect(text).toContain('trunc(1)')
      expect(await renderWith(text, 19.99)).toBe('19.9')
      expect(await renderWith(text, 21.96)).toBe('21.9')
    })
  })

  it('sets a slot aside when it names a device whose alias is "camera", and every migrated text renders', async () => {
    const notes: { message: string; deviceId?: number }[] = []
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
              source: {
                kind: 'device-state',
                deviceId: GARAGE,
                capName: 'switch',
                valuePath: 'on',
              },
              template: '${value}',
              maxDecimals: 1,
            },
            'text-2': {
              enabled: true,
              source: { kind: 'device-state', capName: 'motion', valuePath: 'detected' },
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
        readAliases: async () => new Map([[GARAGE, 'camera']]),
        note: (message, deviceId) =>
          void notes.push({ message, ...(deviceId === undefined ? {} : { deviceId }) }),
      }),
    })
    expect((await f.boot()).failed).toEqual([])
    const bindings = value(f.deviceRows()[`${OWNER}:${CAMERA}.slotBindings`])
    expect(bindings).toMatchObject({ 'text-1': { enabled: false, source: { kind: 'none' } } })
    expect(notes.some((n) => n.deviceId === CAMERA && n.message.includes('"camera"'))).toBe(true)
    // Every text the migration wrote resolves against the aliases that exist (the host names the
    // camera `camera` and nothing named after the clashing device).
    const texts = JSON.stringify(f.rows()[`${OWNER}.namedTemplates`]).match(/\{\{[^"]*?\}\}/g) ?? []
    expect(texts.length).toBeGreaterThan(0)
    for (const text of texts) {
      const out = await renderer.render(text.replace(/\\"/g, '"'), {
        viewOf: (alias) => (alias === 'camera' ? view(CAMERA) : undefined),
      })
      expect(out.ok).toBe(true)
    }
  })
})
