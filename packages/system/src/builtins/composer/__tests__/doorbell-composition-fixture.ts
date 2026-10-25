import type { DoorbellStatus } from '@camstack/types'
import {
  ALL_CAPABILITY_DEFINITIONS,
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  compilePulseOverride,
  DeviceType,
  EventCategory,
  type SystemEvent,
} from '@camstack/types'
import { MirrorRowWriter } from '../../device-manager/mirror-row-writer.js'
import { buildWorld, CALLER, type PersistedHub } from './feeder-world.js'

export const CAMERA_101 = {
  id: 101,
  addonId: 'provider-hikvision',
  stableId: 'mac-40acbf7be9f7',
} as const

export const SOURCE_1031 = {
  id: 1031,
  addonId: 'provider-homeassistant',
  stableId: 'ha:ha_001:dev:bf38dbc6816ab9fdbd7f8f6b1eb4638b-switch.doorbell_bussano',
} as const

export const SECONDARY_TEST_SOURCE = {
  id: 1032,
  addonId: 'provider-homeassistant',
  stableId: 'ha:test:dev:doorbell-secondary-switch',
} as const

function operatorDoorbell(
  camera: CompositionSourceRef,
  sources: readonly CompositionSourceRef[],
): CompositionFieldsFeature {
  const compiled = compilePulseOverride({
    draft: {
      kind: 'pulse',
      cap: 'doorbell',
      targetId: 'pressed',
      enabled: true,
      debounceMs: 2_000,
      sources: sources.map((source) => ({
        addonId: source.addonId,
        stableId: source.stableId,
        cap: 'switch',
        fieldPath: 'on',
      })),
    },
    device: camera,
    changedAtFields: sources.map(() => 'lastChangedAt'),
  })
  if (!compiled.ok) throw new Error(compiled.reason)
  return compiled.value
}

/**
 * A native doorbell slice on 101. The composer must not adopt it (D938): with
 * no claimed stamp and no source rise it seeds "no ring". A restart keeps the
 * stamp the claim already holds, which these tests persist and read back.
 * Without the option the fixture starts from no doorbell slice at all.
 */
export const INITIAL_DOORBELL: DoorbellStatus = {
  lastPressedAt: 1_790_587_990_669,
  pressCountSinceStart: 2,
}

const INITIAL_SOURCE = { on: false, lastChangedAt: INITIAL_DOORBELL.lastPressedAt }
export interface DoorbellCompositionFixtureOptions {
  /** The doorbell slice on 101 before its customization is created: absent (`null`, the default) or a seed. */
  readonly seededDoorbellSlice?: DoorbellStatus | null
  readonly secondarySource?: boolean
  readonly from?: PersistedHub
  readonly sourceInitial?: Readonly<Record<string, unknown>>
}

export interface DoorbellClaimControl {
  started(): boolean
  settled(): boolean
  resolve(): void
}

export interface DoorbellCompositionFixture {
  holdNextClaim(): DoorbellClaimControl
  sourceSwitch(input: {
    readonly on: boolean
    readonly changedAt: number
    readonly source?: 'primary' | 'secondary'
  }): Promise<void>
  unregisterSource(source: 'primary' | 'secondary'): void
  /** The provider registers the source's switch cap again (a redeploy coming back). */
  reregisterSource(source: 'primary' | 'secondary'): void
  flushRuntime(): Promise<void>
  flushDurable(): Promise<void>
  idle(): Promise<void>
  shutdown(): Promise<void>
  /** The effective doorbell slice on 101; `null` when there is none — never a stand-in. */
  effective(): Promise<DoorbellStatus | null>
  events(): readonly SystemEvent[]
  /** `DeviceStateChanged` events for 101's doorbell, in order. */
  doorbellStateChanges(): readonly SystemEvent[]
  composerBound(): Promise<boolean>
  lifecycleBindingsChanged(): void
  failNextOwnedWrite(): void
  persisted(): Promise<PersistedHub>
  timeline(): readonly string[]
}

function event(category: string, data: Record<string, unknown>): SystemEvent {
  return {
    id: 'doorbell-composition-fixture',
    timestamp: new Date(),
    source: { type: 'device', id: CAMERA_101.id },
    category,
    data,
  } as SystemEvent
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function createDoorbellCompositionFixture(
  overrides: Partial<DoorbellCompositionFixtureOptions> = {},
): Promise<DoorbellCompositionFixture> {
  const options: DoorbellCompositionFixtureOptions = {
    secondarySource: false,
    ...overrides,
  }
  const initialSource = options.sourceInitial ?? INITIAL_SOURCE

  const world = await buildWorld({
    ...(options.from === undefined ? {} : { from: options.from }),
    beforeComposer: async ({ dm, ha }) => {
      if (options.from === undefined) {
        await dm.provider.registerDevice({
          addonId: CAMERA_101.addonId,
          stableId: CAMERA_101.stableId,
          id: CAMERA_101.id,
          type: DeviceType.Camera,
          name: 'Doorbell acceptance camera',
          parentDeviceId: null,
          config: {},
        })
      }
      const primaryId = await ha.adopt(SOURCE_1031, DeviceType.Switch, null, SOURCE_1031.id)
      ha.register(primaryId, 'switch')
      await ha.push(primaryId, 'switch', initialSource)
      if (options.secondarySource) {
        const secondaryId = await ha.adopt(
          SECONDARY_TEST_SOURCE,
          DeviceType.Switch,
          null,
          SECONDARY_TEST_SOURCE.id,
        )
        ha.register(secondaryId, 'switch')
        await ha.push(secondaryId, 'switch', {
          on: false,
          lastChangedAt: INITIAL_DOORBELL.lastPressedAt,
        })
      }
    },
  })

  const timeline: string[] = []
  const emit = world.bus.emit.bind(world.bus)
  world.bus.emit = (entry) => {
    if (entry.category === EventCategory.DoorbellOnPressed) timeline.push('doorbell-event')
    emit(entry)
  }
  const snapshotCapability = ALL_CAPABILITY_DEFINITIONS.find((cap) => cap.name === 'snapshot')
  if (snapshotCapability === undefined) throw new Error('snapshot capability is missing')
  const cameraContext = world
    .createProviderApi(CAMERA_101.addonId)
    .createContext(CAMERA_101.stableId, CAMERA_101.id)
  const snapshotProvider = Object.fromEntries(
    Object.keys(snapshotCapability.methods).map((method) => [method, async () => null]),
  )
  cameraContext.registerNativeCap(snapshotCapability, snapshotProvider)
  if (options.from === undefined) {
    const seededDoorbellSlice = options.seededDoorbellSlice ?? null
    if (seededDoorbellSlice !== null)
      await world.dm.setCapSlice(CAMERA_101.id, 'doorbell', { ...seededDoorbellSlice })
  } else {
    const persistedState = await options.from.settings.readDeviceRuntimeState(CAMERA_101.id)
    const nativeDoorbell = persistedState['doorbell']
    const ownedCaps = persistedState['$owned']
    const ownedDoorbell = isRecord(ownedCaps) ? ownedCaps['doorbell'] : null
    const ownedValues = isRecord(ownedDoorbell) ? ownedDoorbell['values'] : null
    // The composer's owned values are what survives; a native slice exists only
    // when a test seeded one.
    if (!isRecord(ownedValues)) throw new Error('persisted camera 101 doorbell state is incomplete')
    await world.dm.setCapSlice(CAMERA_101.id, 'doorbell', {
      ...(isRecord(nativeDoorbell) ? nativeDoorbell : {}),
      ...ownedValues,
    })
  }
  await world.blocks.load()

  if (options.from === undefined) {
    // 101's customization, as the operator's Customize → Doorbell writes it
    // (one D671 builder). A restart reads it back from `from`.
    const camera: CompositionSourceRef = {
      addonId: CAMERA_101.addonId,
      stableId: CAMERA_101.stableId,
    }
    const refs = [
      { addonId: SOURCE_1031.addonId, stableId: SOURCE_1031.stableId },
      ...(options.secondarySource
        ? [{ addonId: SECONDARY_TEST_SOURCE.addonId, stableId: SECONDARY_TEST_SOURCE.stableId }]
        : []),
    ]
    const feature = operatorDoorbell(camera, refs)
    await world.compositions.createComposition({
      block: {
        enabled: true,
        composition: {
          target: { kind: 'existing', device: camera },
          features: [feature],
        },
      },
      caller: CALLER,
    })
  }
  let pendingClaim: {
    readonly wait: Promise<void>
    readonly start: () => void
    readonly finish: () => void
  } | null = null
  let rejectNextWrite = false
  const originalClaim = world.dm.deviceState.claimFields
  const originalPatch = world.dm.deviceState.patchOwnedFields
  const gateRpc = async <T>(run: () => Promise<T>): Promise<T> => {
    const claim = pendingClaim
    timeline.push(claim === null ? 'owned-field-rpc' : 'held-owned-field-rpc')
    const perform = async (): Promise<T> => {
      if (rejectNextWrite) {
        rejectNextWrite = false
        throw new Error('fixture owned-field write failure')
      }
      return run()
    }
    if (claim === null) return perform()
    pendingClaim = null
    claim.start()
    try {
      await claim.wait
      return await perform()
    } finally {
      claim.finish()
    }
  }
  world.dm.deviceState.claimFields = (input) => gateRpc(() => originalClaim(input))
  world.dm.deviceState.patchOwnedFields = (input) => gateRpc(() => originalPatch(input))

  const waitRuntime = async (): Promise<void> => {
    for (let turn = 0; turn < 8; turn++) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const effective = async (): Promise<DoorbellStatus | null> => {
    const slice = await world.dm.deviceState.getCapSlice({
      deviceId: CAMERA_101.id,
      capName: 'doorbell',
    })
    if (slice === null || slice === undefined) return null
    const lastPressedAt = slice['lastPressedAt']
    const count = slice['pressCountSinceStart']
    return {
      lastPressedAt: typeof lastPressedAt === 'number' ? lastPressedAt : null,
      // A missing count is reported as what it is, never folded into 0 (D393).
      pressCountSinceStart: typeof count === 'number' ? count : Number.NaN,
    }
  }
  await world.supervisor.converge()
  await world.supervisor.converge()
  await world.supervisor.converge()
  await waitRuntime()

  return {
    holdNextClaim() {
      let releaseGate = (): void => undefined
      let started = false
      let settled = false
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      const control: DoorbellClaimControl = {
        started: () => started,
        settled: () => settled,
        resolve: () => releaseGate(),
      }
      pendingClaim = {
        wait: gate,
        start: () => {
          started = true
        },
        finish: () => {
          settled = true
        },
      }
      return control
    },
    async sourceSwitch({ on, changedAt, source = 'primary' }) {
      const deviceId = source === 'primary' ? SOURCE_1031.id : SECONDARY_TEST_SOURCE.id
      await world.ha.push(deviceId, 'switch', { on, lastChangedAt: changedAt })
    },
    unregisterSource(source) {
      const deviceId = source === 'primary' ? SOURCE_1031.id : SECONDARY_TEST_SOURCE.id
      world.ha.unregister(deviceId, 'switch')
    },
    reregisterSource(source) {
      const deviceId = source === 'primary' ? SOURCE_1031.id : SECONDARY_TEST_SOURCE.id
      world.ha.register(deviceId, 'switch')
    },
    flushRuntime: waitRuntime,
    async flushDurable() {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, MirrorRowWriter.RUNTIME_STATE_DEBOUNCE_MS + 10),
      )
    },
    async idle() {
      await waitRuntime()
    },
    async shutdown() {
      await world.composerAddon.shutdown()
    },
    effective,
    events: () =>
      world.events.filter((entry) => entry.category === EventCategory.DoorbellOnPressed),
    doorbellStateChanges: () =>
      world.events.filter(
        (entry) =>
          entry.category === EventCategory.DeviceStateChanged &&
          isRecord(entry.data) &&
          entry.data['deviceId'] === CAMERA_101.id &&
          entry.data['capName'] === 'doorbell',
      ),
    async composerBound() {
      const read = await world.dm.provider.getBindings({ deviceId: CAMERA_101.id })
      return read.entries.some(
        (entry) => entry.capName === 'doorbell' && entry.providerAddonId === 'composer',
      )
    },
    lifecycleBindingsChanged() {
      world.bus.emit(
        event(EventCategory.DeviceBindingsChanged, {
          deviceId: CAMERA_101.id,
          capName: 'doorbell',
          reason: 'fixture',
          addonId: 'composer',
          nodeId: 'hub',
        }),
      )
    },
    failNextOwnedWrite() {
      rejectNextWrite = true
    },
    persisted: () => world.persisted(),
    timeline: () => timeline,
  }
}
