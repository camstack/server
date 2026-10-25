import { describe, expect, it, vi } from 'vitest'
import {
  DECLARED_DEVICE_SWEEP_LIMIT,
  type DeclaredDevicePorts,
  type DeclaredDeviceRow,
  DeclaredDevices,
  type DeviceDeclaration,
  declarationOwnerNodeId,
} from '../declared-device.js'
import type { IDevice } from '../device.js'
import type { DeviceConstructor, DeviceManagerApi } from '../device-context.js'
import { DeviceType } from '../device-type.js'

const PANEL_STABLE_ID = 'nc-alarm-panel'
const INTEGRATION_ID = 'int_0018'

class FakePanel {
  readonly id: number
  /** A real device carries its stableId — the kernel registry and the
   *  reconcile's live-device index both key on it. A fake without one hides
   *  every bug that lives in that lookup. */
  readonly stableId: string
  constructor(id: number, stableId: string) {
    this.id = id
    this.stableId = stableId
  }
}

const PanelClass = FakePanel as unknown as DeviceConstructor<IDevice>

const DECLARATION: DeviceDeclaration = {
  stableId: PANEL_STABLE_ID,
  name: 'Alarm',
  type: DeviceType.AlarmPanel,
  DeviceClass: PanelClass,
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as DeclaredDevicePorts['logger']
}

interface HarnessOptions {
  /** One entry per `listOwnDevices()` call, in order. The last repeats. */
  readonly indexReads: ReadonlyArray<readonly DeclaredDeviceRow[]>
  readonly integration?: { id: string; info?: Record<string, unknown> | null } | null
  readonly localNodeId?: string
}

interface Harness {
  readonly ports: DeclaredDevicePorts
  readonly create: ReturnType<typeof vi.fn>
  readonly remove: ReturnType<typeof vi.fn>
  readonly updateIntegration: ReturnType<typeof vi.fn>
  readonly createIntegration: ReturnType<typeof vi.fn>
  readonly listOwnDevices: ReturnType<typeof vi.fn>
  readonly getAll: ReturnType<typeof vi.fn>
  readonly logger: DeclaredDevicePorts['logger']
}

function harness(opts: HarnessOptions): Harness {
  // The kernel REGISTERS what `create` returns, and refuses a second object for
  // an id it already holds. The fake models that: everything created stays
  // live and is visible to `getAll`. Without this the reconcile's idempotency
  // guard cannot be exercised at all — it silently degrades to the old path and
  // the suite stays green over the bug.
  const liveDevices: FakePanel[] = []
  const create = vi.fn(async (stableId: string) => {
    const device = new FakePanel(stableId === PANEL_STABLE_ID ? 42 : 99, stableId)
    liveDevices.push(device)
    return device
  })
  const getAll = vi.fn(async () => liveDevices as ReadonlyArray<FakePanel>)
  const remove = vi.fn(async () => undefined)
  const updateIntegration = vi.fn(async () => undefined)
  const createIntegration = vi.fn(async () => ({ id: 'int_new' }))
  let read = 0
  const listOwnDevices = vi.fn(async () => {
    const at = Math.min(read, opts.indexReads.length - 1)
    read += 1
    return opts.indexReads[at] ?? []
  })
  const logger = makeLogger()
  const devices = { create, remove, getAll } as unknown as DeviceManagerApi
  const integration =
    opts.integration === undefined
      ? { id: INTEGRATION_ID, info: { fixed: true } }
      : opts.integration
  const ports: DeclaredDevicePorts = {
    logger,
    addonId: 'pipeline-analytics',
    devices,
    localNodeId: opts.localNodeId ?? 'hub',
    getIntegration: async () => integration,
    createIntegration,
    updateIntegration,
    listOwnDevices,
  }
  return {
    ports,
    create,
    remove,
    updateIntegration,
    createIntegration,
    listOwnDevices,
    getAll,
    logger,
  }
}

const SPEC = { integrationName: 'Notification Center', devices: [DECLARATION] }

describe('declarationOwnerNodeId', () => {
  it('strips the `<node>/<addon>` suffix a forked child carries', () => {
    expect(declarationOwnerNodeId('hub/pipeline-analytics')).toBe('hub')
    expect(declarationOwnerNodeId('agent-a/pipeline-analytics')).toBe('agent-a')
    expect(declarationOwnerNodeId('hub')).toBe('hub')
    expect(declarationOwnerNodeId(undefined)).toBe('hub')
  })
})

describe('DeclaredDevices — the owner half of (addonId, stableId)', () => {
  /**
   * `ctx.addonId` DOES NOT EXIST. The addon id is `ctx.id`, and every declarer
   * hand-wires these ports, so reaching for the field that reads like the right
   * one is a mistake with no compiler and no runtime signal behind it: the
   * ports type says `string`, the value that arrives is not, and nothing looks.
   *
   * It is not cosmetic. `listOwnDevices` is wired from this same id, and a
   * `listAll` with no owner answers with every device on the cluster — which
   * this class would then treat as its own index, colliding `stableId` lookups
   * with other addons' and letting the withdrawal sweep consider rows it does
   * not own. Refuse at construction, where the wiring mistake is, rather than
   * at the first destructive pass.
   */
  it('refuses ports whose addonId is not a real id', () => {
    const h = harness({ indexReads: [[]] })
    // How the mistake actually looks at the call site: `addonId: ctx.addonId`.
    const missing: DeclaredDevicePorts = { ...h.ports, addonId: JSON.parse('null') }

    expect(() => new DeclaredDevices(missing)).toThrow(/addonId/)
    expect(() => new DeclaredDevices({ ...h.ports, addonId: '' })).toThrow(/addonId/)
  })

  it('accepts a real id', () => {
    // Discriminating: a guard on the wrong predicate (say, truthiness of the
    // whole ports object) would pass the test above and reject every real
    // declarer here.
    const h = harness({ indexReads: [[]] })
    expect(() => new DeclaredDevices(h.ports)).not.toThrow()
  })
})

describe('DeclaredDevices.reconcile', () => {
  it('creates the device on the first pass, with its declared meta', async () => {
    const h = harness({ indexReads: [[]] })
    const result = await new DeclaredDevices(h.ports).reconcile(SPEC)

    expect(result.owned).toBe(true)
    expect(result.integrationId).toBe(INTEGRATION_ID)
    expect(result.devices).toHaveLength(1)
    expect(result.devices[0]?.created).toBe(true)
    expect(h.create).toHaveBeenCalledWith(PANEL_STABLE_ID, PanelClass, {}, null, {
      type: DeviceType.AlarmPanel,
      name: 'Alarm',
      integrationId: INTEGRATION_ID,
    })
  })

  it('ADOPTS an existing device instead of skipping it, and never re-seeds the name', async () => {
    const h = harness({
      indexReads: [[{ id: 42, stableId: PANEL_STABLE_ID, integrationId: INTEGRATION_ID }]],
    })
    const result = await new DeclaredDevices(h.ports).reconcile(SPEC)

    expect(result.devices[0]).toMatchObject({ deviceId: 42, created: false })
    expect(h.create).toHaveBeenCalledOnce()
    expect(h.create).toHaveBeenCalledWith(PANEL_STABLE_ID, PanelClass, {}, null, undefined)
  })

  /**
   * THE BUG THAT DIES IN THIS MIGRATION.
   *
   * `ensureAlarmPanel` read the device index ONCE. A transiently empty answer —
   * a cold registry, a `listAll` that lost a race, the same shape as the live
   * `getAllBindings → []` defect — is indistinguishable from a first boot, and
   * the first-boot branch seeds `initialMeta`, whose `name` lands as an
   * unconditional `setName`. The operator's rename disappeared, silently, on a
   * restart.
   *
   * Remove the second read in `applyDeclaration` and this test fails: `create`
   * is called with the declared meta instead of `undefined`.
   */
  it('never re-creates on a transiently empty index — the destructive read needs a second to agree', async () => {
    const h = harness({
      indexReads: [[], [{ id: 42, stableId: PANEL_STABLE_ID, integrationId: INTEGRATION_ID }]],
    })
    const result = await new DeclaredDevices(h.ports).reconcile(SPEC)

    // ADOPT: no `initialMeta`, so no `setName`, so the operator's rename lives.
    expect(h.create).toHaveBeenCalledWith(PANEL_STABLE_ID, PanelClass, {}, null, undefined)
    expect(result.devices[0]).toMatchObject({ deviceId: 42, created: false })
    expect(h.listOwnDevices).toHaveBeenCalledTimes(2)
    expect(h.logger.warn).toHaveBeenCalledWith(
      'device index disagreed with itself — adopting instead of re-creating',
      expect.objectContaining({ tags: { deviceId: 42 } }),
    )
  })

  it('creates only when BOTH reads agree the device is absent', async () => {
    const h = harness({ indexReads: [[], []] })
    await new DeclaredDevices(h.ports).reconcile(SPEC)

    expect(h.listOwnDevices).toHaveBeenCalledTimes(2)
    expect(h.create).toHaveBeenCalledWith(
      PANEL_STABLE_ID,
      PanelClass,
      {},
      null,
      expect.objectContaining({ name: 'Alarm' }),
    )
  })

  it('changes NOTHING when the index read fails', async () => {
    const h = harness({ indexReads: [[]] })
    h.listOwnDevices.mockRejectedValue(new Error('registry cold'))

    await expect(new DeclaredDevices(h.ports).reconcile(SPEC)).rejects.toThrow('registry cold')
    expect(h.create).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('re-asserts `fixed` on an integration that predates the flag, every pass', async () => {
    const h = harness({
      indexReads: [[{ id: 42, stableId: PANEL_STABLE_ID, integrationId: INTEGRATION_ID }]],
      integration: { id: INTEGRATION_ID, info: {} },
    })
    await new DeclaredDevices(h.ports).reconcile(SPEC)

    expect(h.updateIntegration).toHaveBeenCalledWith({ id: INTEGRATION_ID, info: { fixed: true } })
    expect(h.createIntegration).not.toHaveBeenCalled()
  })

  it('creates the integration as fixed when there is none', async () => {
    const h = harness({ indexReads: [[]], integration: null })
    await new DeclaredDevices(h.ports).reconcile(SPEC)

    expect(h.createIntegration).toHaveBeenCalledWith({
      addonId: 'pipeline-analytics',
      name: 'Notification Center',
      info: { fixed: true },
    })
    expect(h.updateIntegration).not.toHaveBeenCalled()
  })

  it('uses a supplied integrationId verbatim, and mints nothing', async () => {
    // A CORE BLOCK cannot own an integration: every integration READ is
    // filtered by `installedAddonIds` (addon-registry.service.ts
    // `createFilteredRegistry`), and a block's addon id (`core-block-<uuid>`)
    // is never in that set. `getIntegration` therefore always answers null, so
    // the mint branch runs on EVERY start and leaks a fresh row that
    // `listIntegrations` then hides and `deleteIntegration` refuses to remove.
    // Verified on the live hub 2026-08-09: int_0021 and int_0022, two starts of
    // one block, both unreachable. A block hangs its devices off the integration
    // an INSTALLED addon owns instead, and passes that id in.
    const h = harness({ indexReads: [[]], integration: null })
    const result = await new DeclaredDevices(h.ports).reconcile({
      ...SPEC,
      integrationId: 'int_0007',
    })

    expect(h.createIntegration).not.toHaveBeenCalled()
    expect(h.updateIntegration).not.toHaveBeenCalled()
    expect(result.integrationId).toBe('int_0007')
    expect(h.create).toHaveBeenCalledWith(
      PANEL_STABLE_ID,
      PanelClass,
      {},
      null,
      expect.objectContaining({ integrationId: 'int_0007' }),
    )
  })

  it('bounds the withdrawal sweep by the SUPPLIED integration, not a minted one', async () => {
    // Discriminating on purpose: with the supplied id ignored, `integrationId`
    // would be the freshly minted `int_new`, row 77 would match nothing and the
    // withdrawal would silently never happen. A block whose declaration is
    // removed would keep its device forever, which is the failure this option
    // is meant to make impossible.
    //
    // Row 77 is the SAME addon's withdrawn device — `listOwnDevices` is
    // addon-scoped, so a sibling block's row can never appear here — while row
    // 88 sits outside the integration and must survive regardless.
    const h = harness({
      indexReads: [
        [
          { id: 42, stableId: PANEL_STABLE_ID, integrationId: 'int_0007' },
          { id: 77, stableId: 'withdrawn-declaration', integrationId: 'int_0007' },
          { id: 88, stableId: 'not-in-this-integration', integrationId: 'int_0013' },
        ],
      ],
      integration: null,
    })
    const result = await new DeclaredDevices(h.ports).reconcile({
      ...SPEC,
      integrationId: 'int_0007',
    })

    expect(result.removed).toEqual([77])
    expect(h.remove).toHaveBeenCalledTimes(1)
  })

  it('skips every node but the hub by default', async () => {
    const h = harness({ indexReads: [[]], localNodeId: 'agent-a/pipeline-analytics' })
    const result = await new DeclaredDevices(h.ports).reconcile(SPEC)

    expect(result).toEqual({ integrationId: null, devices: [], removed: [], owned: false })
    expect(h.create).not.toHaveBeenCalled()
  })

  it('acts on the hub even when localNodeId carries the forked-child suffix', async () => {
    const h = harness({ indexReads: [[]], localNodeId: 'hub/pipeline-analytics' })
    const result = await new DeclaredDevices(h.ports).reconcile(SPEC)

    expect(result.owned).toBe(true)
    expect(h.create).toHaveBeenCalled()
  })

  it('removes a device whose declaration was withdrawn, and logs it per device', async () => {
    const h = harness({
      indexReads: [
        [
          { id: 42, stableId: PANEL_STABLE_ID, integrationId: INTEGRATION_ID },
          { id: 77, stableId: 'retired-panel', integrationId: INTEGRATION_ID },
        ],
      ],
    })
    const result = await new DeclaredDevices(h.ports).reconcile(SPEC)

    expect(result.removed).toEqual([77])
    expect(h.remove).toHaveBeenCalledWith(77)
    expect(h.logger.info).toHaveBeenCalledWith(
      'declared device removed — its declaration was withdrawn',
      expect.objectContaining({ tags: { deviceId: 77 } }),
    )
  })

  it('never sweeps a device outside the declared integration', async () => {
    const h = harness({
      indexReads: [
        [
          { id: 42, stableId: PANEL_STABLE_ID, integrationId: INTEGRATION_ID },
          { id: 88, stableId: 'a-camera', integrationId: 'int_other' },
          { id: 89, stableId: 'no-integration', integrationId: null },
        ],
      ],
    })
    const result = await new DeclaredDevices(h.ports).reconcile(SPEC)

    expect(result.removed).toEqual([])
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('removes nothing when the sweep would exceed its bound', async () => {
    const rows: DeclaredDeviceRow[] = Array.from(
      { length: DECLARED_DEVICE_SWEEP_LIMIT + 1 },
      (_, i) => ({ id: 100 + i, stableId: `gone-${i}`, integrationId: INTEGRATION_ID }),
    )
    const h = harness({ indexReads: [rows] })
    const result = await new DeclaredDevices(h.ports).reconcile(SPEC)

    expect(result.removed).toEqual([])
    expect(h.remove).not.toHaveBeenCalled()
    expect(h.logger.warn).toHaveBeenCalledWith(
      'withdrawal sweep exceeded its bound — removing nothing',
      expect.anything(),
    )
  })

  it('one failing declaration does not take the others down', async () => {
    const other: DeviceDeclaration = {
      stableId: 'second-panel',
      name: 'Second',
      type: DeviceType.AlarmPanel,
      DeviceClass: PanelClass,
    }
    const h = harness({ indexReads: [[]] })
    h.create.mockImplementationOnce(async () => {
      throw new Error('device class blew up')
    })
    const result = await new DeclaredDevices(h.ports).reconcile({
      integrationName: 'Notification Center',
      devices: [DECLARATION, other],
    })

    expect(result.devices).toHaveLength(1)
    expect(result.devices[0]?.stableId).toBe('second-panel')
    expect(h.logger.warn).toHaveBeenCalledWith(
      'a declared device could not be brought up',
      expect.anything(),
    )
  })

  /**
   * Reconcile runs on a timer. Before 2026-08-11 the adopt branch called
   * `devices.create` on EVERY pass, and the kernel registry refuses a second
   * object for an id it already holds — so from the second pass onward every
   * declared device threw `Device numeric id N already registered`, once a
   * minute, and its camera never came up. Measured live: a Terminal instance
   * existed with no camera, and the warning printed the same stableId on both
   * sides of the error, so it read like a self-collision rather than a
   * re-registration.
   */
  it('is idempotent across passes — a live device is adopted, never re-created', async () => {
    // Pass 1 sees nothing — TWICE, because the D49 confirmation read has to
    // agree before the create branch runs. Pass 2 then sees the persisted row
    // AND, through `getAll`, the live object pass 1 constructed.
    const h = harness({
      indexReads: [[], [], [{ id: 42, stableId: PANEL_STABLE_ID, integrationId: INTEGRATION_ID }]],
    })
    const declared = new DeclaredDevices(h.ports)

    const first = await declared.reconcile(SPEC)
    expect(first.devices[0]?.created).toBe(true)
    expect(h.create).toHaveBeenCalledTimes(1)

    const second = await declared.reconcile(SPEC)

    // The device is still reported — returning nothing would leave it listed
    // but answering nothing, which is what the adopt branch exists to avoid.
    expect(second.devices).toHaveLength(1)
    expect(second.devices[0]).toMatchObject({ stableId: PANEL_STABLE_ID, created: false })
    expect(second.devices[0]?.deviceId).toBe(42)
    // …and NOT constructed a second time.
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.logger.warn).not.toHaveBeenCalledWith(
      'a declared device could not be brought up',
      expect.anything(),
    )
  })

  it('still adopts when a row exists but no object was ever constructed', async () => {
    // The guard must not swallow the case it was NOT written for: a persisted
    // row with no live device (a fresh boot) still needs bringing up.
    const h = harness({
      indexReads: [[{ id: 42, stableId: PANEL_STABLE_ID, integrationId: INTEGRATION_ID }]],
    })
    const result = await new DeclaredDevices(h.ports).reconcile(SPEC)

    expect(h.create).toHaveBeenCalledTimes(1)
    expect(result.devices[0]).toMatchObject({ stableId: PANEL_STABLE_ID, created: false })
  })
})
