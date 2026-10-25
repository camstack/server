/**
 * The `osd-manager` provider — the render loop and the operator surface.
 *
 * Every camera interaction goes through the device-scope `osd` cap
 * (`ctx.api.osd.*`); this addon never speaks a firmware protocol. Every
 * value it renders comes from the kernel's device-state mirror
 * (`ctx.api.deviceState.getSnapshot`); it never polls a sensor itself.
 *
 * The one property to preserve if this file is ever rewritten: **a slot is
 * written only when its rendered text CHANGED**. `lastWritten` is that
 * memory. Without it, a 10-second tick is one firmware round-trip per slot
 * per tick, forever, for a string that did not move.
 */
import {
  type IOsdManagerProvider,
  type IScopedLogger,
  NC_CONDITION_CATALOG,
  type NcConditionDescriptor,
  type OsdNamedTemplate,
  type OsdRenderResult,
  type OsdSlotBinding,
  type OsdSlotView,
  type OsdSourceOption,
  type OsdStatus,
  type PipelineAnalyticsTrackLifecyclePayload,
  readDeviceStateFrom,
} from '@camstack/types'
import type { BindingsHandle, OsdDeviceBindings } from './bindings-store.js'
import { EMPTY_BINDINGS, withBinding, withoutBinding } from './bindings-store.js'
import type { BoundIndexHandle } from './bound-index.js'
import { assertSupportedConditions, OSD_SUPPORTED_CONDITIONS } from './gate.js'
import { mapWithConcurrency } from './lane-pool.js'
import { type OsdFacts, renderSlot } from './render.js'
import { sourceOptionsFor } from './source-catalog.js'
import {
  deleteNamedTemplate,
  findNamedTemplate,
  type TemplatesHandle,
  upsertNamedTemplate,
} from './templates-store.js'

export interface OsdCameraStatusReader {
  (deviceId: number): Promise<OsdStatus | null>
}

export interface OsdOverlayWriter {
  (deviceId: number, overlayId: string, patch: { enabled?: boolean; text?: string }): Promise<void>
}

export interface OsdDeviceSummary {
  readonly id: number
  readonly name: string
  /** DeviceType string; containers are excluded from the source catalog. */
  readonly type?: string | null
}

export interface OsdManagerDeps {
  readonly logger: IScopedLogger
  /** `osd.getStatus` for a camera. `null` when the camera has no `osd` cap. */
  readonly readOsdStatus: OsdCameraStatusReader
  /** `osd.setOverlay`. */
  readonly writeOverlay: OsdOverlayWriter
  /** `deviceState.getSnapshot` — the whole cap-keyed state blob for a device. */
  readonly readDeviceSnapshot: (deviceId: number) => Promise<Record<string, unknown>>
  /** Every device in the cluster, for the source catalog and its labels. A slot
   *  may render state from ANY device, so this one cannot be narrowed. */
  readonly listDevices: () => Promise<readonly OsdDeviceSummary[]>
  /** CAMERAS only — the reconcile's work list. Only a camera can carry an
   *  overlay, so reading the other 946 rows of a 976-device directory answered
   *  a question nobody asked; the filter belongs server-side
   *  (`listAll({ isCamera: true })`), not in a client-side `.filter`. */
  readonly listCameras: () => Promise<readonly OsdDeviceSummary[]>
  /** The durable work list. See `bound-index.ts`. */
  readonly boundIndex: BoundIndexHandle
  /** Cameras reconciled at once. Test seam; production takes
   *  {@link RECONCILE_CONCURRENCY}. */
  readonly reconcileConcurrency?: number
  /**
   * Cap names currently bound on a NAMED SET of devices — what each can
   * actually publish.
   *
   * The set, never one device at a time. The source catalog asks this about
   * every device in the cluster (see {@link OsdManagerDeps.listDevices}: a slot
   * may render state from ANY device, so the question cannot be narrowed), and
   * asking it per device was 1 019 sequential cross-process cap calls behind an
   * operator opening a slot editor on the live hub 2026-08-30 — each one itself
   * a store-backed resolve. `deviceManager.getBindingsBatch` answers the whole
   * set in one round trip, with the same resolver and the same per-device shape
   * as `getBindings` (a device with nothing bound answers `entries: []` rather
   * than dropping out), so the catalog does not narrow either.
   *
   * A device the answer omits contributes no caps, exactly as a failed
   * per-device read did.
   */
  readonly listDeviceCapsBatch: (
    deviceIds: readonly number[],
  ) => Promise<ReadonlyMap<number, readonly string[]>>
  /** Latest durable face/plate gallery values for this camera. */
  readonly readLatestRecognitions: (deviceId: number) => Promise<{
    readonly person?: TimedRecognition
    readonly plate?: TimedRecognition
  }>
  /** Durable per-device binding map. */
  readonly bindings: (deviceId: number) => BindingsHandle
  /** Named multi-device templates (plugin catalog Templates parity). */
  readonly templates: TemplatesHandle
  readonly now?: () => number
}

/** How often every bound camera is re-rendered when nothing else wakes us. */
export const DEFAULT_TICK_MS = 10_000

/**
 * Cameras whose bindings the reconcile reads at once.
 *
 * Each unit is one UDS round-trip to the settings store — measured at 559 ms
 * under boot load on 2026-08-19, which is latency, not CPU, so serialising it
 * bought nothing and cost everything (D167). The bound protects the settings
 * store, which every other addon on the node shares; four is the same ceiling
 * `HYDRATE_DEVICE_CONCURRENCY` and the zone-mirror sweep settled on.
 */
export const RECONCILE_CONCURRENCY = 4

/** Why the reconcile is running — it decides how loud a difference is. */
export type ReconcileMode = 'seed' | 'reconcile'

/** One camera's binding read. `bindings: null` ⇒ the read FAILED and therefore
 *  decides nothing (D49). */
interface BindingProbe {
  readonly deviceId: number
  readonly bindings: OsdDeviceBindings | null
}

type RecognitionKind = 'person' | 'plate'
interface TimedRecognition {
  readonly text: string
  readonly atMs: number
}
type CameraRecognitions = Partial<Record<RecognitionKind, TimedRecognition>>

export class OsdManager implements IOsdManagerProvider {
  private readonly logger: IScopedLogger
  private readonly now: () => number
  /** `deviceId:slotId` → the last text WE wrote. The no-op write guard. */
  private readonly lastWritten = new Map<string, string>()
  /** Cameras with at least one binding — the loop's work list. */
  private readonly boundDevices = new Set<number>()
  private readonly recognitions = new Map<number, CameraRecognitions>()
  private readonly recognitionHydration = new Map<number, Promise<void>>()
  private readonly recognitionGeneration = new Map<number, number>()
  private readonly recognitionInvalidatedAt = new Map<number, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  /** The background reconcile, while one is running. Held so a second arming
   *  cannot overlap the first — two concurrent passes would race on the index
   *  write and could persist the older of the two answers. */
  private reconcile: Promise<void> | null = null

  constructor(private readonly deps: OsdManagerDeps) {
    this.logger = deps.logger
    this.now = deps.now ?? ((): number => Date.now())
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Read the durable work list, start ticking, and arm the reconcile BEHIND
   * both.
   *
   * This used to derive the work list first: list every device, read every
   * device's binding block, one at a time. On 2026-08-19 that was 976 devices ×
   * 559 ms = 546 s, awaited inside `onInitialize`, so every capability this
   * addon declares was absent cluster-wide for nine minutes — and the answer was
   * `boundDevices = 0`. A camera with no binding still costs nothing at runtime;
   * what it used to cost was the boot.
   *
   * The scan did not go away, it moved: it is the reconcile, it runs in the
   * background, and it is the only thing that keeps the index from silently
   * lying.
   */
  async start(tickMs: number): Promise<void> {
    const stored = await this.readBoundIndex()
    if (stored !== null) {
      this.boundDevices.clear()
      for (const deviceId of stored) this.boundDevices.add(deviceId)
    }
    this.timer = setInterval(() => {
      void this.renderAllBound()
    }, tickMs)
    this.logger.info('osd-manager: render loop started', {
      meta: {
        tickMs,
        boundDevices: this.boundDevices.size,
        source: stored === null ? 'seed' : 'durable-index',
      },
    })
    this.armReconcile(stored === null ? 'seed' : 'reconcile')
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.lastWritten.clear()
  }

  /** Resolves when the armed reconcile has settled. Tests await it; production
   *  never does — that is the entire point of arming it. */
  async settleReconcile(): Promise<void> {
    await this.reconcile
  }

  /** Every camera currently on the work list, sorted — the value persisted as
   *  the durable index. */
  get boundDeviceIds(): readonly number[] {
    return [...this.boundDevices].sort((a, b) => a - b)
  }

  /**
   * Keep recognition overlays event-fresh. The persisted-track hydration below
   * remains the restart/cold-start authority; lifecycle events only advance it.
   */
  onTrackLifecycle(payload: PipelineAnalyticsTrackLifecyclePayload): void {
    let changed = false
    if (
      payload.label !== undefined &&
      (payload.bestClassName === 'person' || payload.classes.includes('person'))
    ) {
      changed =
        this.mergeRecognition(
          payload.deviceId,
          'person',
          payload.label,
          payload.lastSeen,
          payload.firstSeen,
        ) || changed
    }

    if (payload.plateText !== undefined) {
      changed =
        this.mergeRecognition(
          payload.deviceId,
          'plate',
          payload.plateText,
          payload.lastSeen,
          payload.firstSeen,
        ) || changed
    }
    if (!changed || !this.boundDevices.has(payload.deviceId)) return
    void this.renderDeviceInternal(payload.deviceId, null).catch((err) => {
      this.logger.warn('osd-manager: recognition-triggered render failed', {
        tags: { deviceId: payload.deviceId },
        meta: { error: String(err) },
      })
    })
  }

  /** Gallery rows are authoritative for corrections, assignments and deletion. */
  onRecognitionGalleryChanged(deviceId: number): void {
    this.recognitionGeneration.set(deviceId, (this.recognitionGeneration.get(deviceId) ?? 0) + 1)
    this.recognitionInvalidatedAt.set(deviceId, this.now())
    this.recognitions.delete(deviceId)
    this.recognitionHydration.delete(deviceId)
    if (!this.boundDevices.has(deviceId)) return
    void this.renderDeviceInternal(deviceId, null).catch((err) => {
      this.logger.warn('osd-manager: gallery-triggered render failed', {
        tags: { deviceId },
        meta: { error: String(err) },
      })
    })
  }

  /**
   * Reconcile the durable index against the store rather than trusting it to be
   * right (D8 — an index nothing checks is an index that eventually lies).
   *
   * Background work, and BOUNDED: cameras only, four reads in flight. Two rules
   * keep it from destroying work:
   *
   * - a binding read that FAILED decides nothing — the camera keeps whatever the
   *   index already said (D49);
   * - a camera absent from the listing is left alone. The device restore pass
   *   runs for minutes after boot (D167), so "not published yet" and "deleted"
   *   look identical from here, and only one of them may unbind a camera. A
   *   real removal comes from `clearSlotBinding`, which is authoritative.
   *
   * Every correction is logged with its `deviceId`, because a silent repair is
   * indistinguishable from an index that was right all along.
   */
  async reconcileBoundDevices(mode: ReconcileMode = 'reconcile'): Promise<void> {
    const cameras = await this.deps.listCameras()
    const probes = await mapWithConcurrency(
      cameras,
      this.deps.reconcileConcurrency ?? RECONCILE_CONCURRENCY,
      async (camera): Promise<BindingProbe> => ({
        deviceId: camera.id,
        bindings: await this.probeBindings(camera.id),
      }),
    )

    const listed = new Set(cameras.map((camera) => camera.id))
    let unreadable = 0
    const added: number[] = []
    const removed: number[] = []

    for (const probe of probes) {
      if (probe.bindings === null) {
        unreadable += 1
        continue
      }
      const bound = Object.keys(probe.bindings).length > 0
      if (bound && !this.boundDevices.has(probe.deviceId)) {
        this.boundDevices.add(probe.deviceId)
        added.push(probe.deviceId)
      } else if (!bound && this.boundDevices.has(probe.deviceId)) {
        this.boundDevices.delete(probe.deviceId)
        removed.push(probe.deviceId)
      }
    }

    if (mode === 'reconcile') {
      for (const deviceId of added) {
        this.logger.warn(
          'osd-manager: bound-device index was missing a camera that HAS bindings — corrected',
          { tags: { deviceId }, meta: { correction: 'added' } },
        )
      }
      for (const deviceId of removed) {
        this.logger.warn(
          'osd-manager: bound-device index claimed a camera with NO bindings — corrected',
          { tags: { deviceId }, meta: { correction: 'removed' } },
        )
      }
    }

    const notListed = [...this.boundDevices].filter((deviceId) => !listed.has(deviceId)).length
    this.logger.info('osd-manager: bound-device reconcile complete', {
      meta: {
        mode,
        cameras: cameras.length,
        bound: this.boundDevices.size,
        added: added.length,
        removed: removed.length,
        unreadable,
        notListed,
      },
    })

    if (mode === 'seed' || added.length > 0 || removed.length > 0) {
      await this.persistBoundIndex(null)
    }
  }

  /**
   * Run the reconcile in the BACKGROUND, once at a time.
   *
   * Nothing on the boot path may await it — that await is what took the
   * capability graph down for nine minutes. A second arming while one is in
   * flight is dropped rather than queued: both passes would compute over the
   * same store and race on the index write.
   */
  private armReconcile(mode: ReconcileMode): void {
    if (this.reconcile !== null) return
    this.reconcile = this.reconcileBoundDevices(mode)
      .catch((err: unknown) => {
        // A reconcile that could not run leaves the index exactly as it was,
        // which is the safe answer — but never a silent one.
        this.logger.warn(
          'osd-manager: bound-device reconcile failed — the index keeps its current contents',
          { meta: { mode, error: String(err) } },
        )
      })
      .finally(() => {
        this.reconcile = null
      })
  }

  /** The persisted index, or `null` when it has never been written (or could
   *  not be read — both mean "derive it from a scan", which is safe). */
  private async readBoundIndex(): Promise<readonly number[] | null> {
    try {
      return await this.deps.boundIndex.get()
    } catch (err) {
      this.logger.warn('osd-manager: bound-device index unreadable — seeding from a camera scan', {
        meta: { error: String(err) },
      })
      return null
    }
  }

  /**
   * Persist the work list. Called from every place a binding is written, so the
   * index cannot drift from the bindings without the write that caused the drift
   * also failing — and that failure is logged, and repaired by the reconcile.
   */
  private async persistBoundIndex(deviceId: number | null): Promise<void> {
    try {
      await this.deps.boundIndex.set([...this.boundDeviceIds])
    } catch (err) {
      this.logger.warn(
        'osd-manager: bound-device index write failed — the next reconcile repairs it',
        {
          ...(deviceId === null ? {} : { tags: { deviceId } }),
          meta: { error: String(err) },
        },
      )
    }
  }

  /** One camera's bindings, or `null` when the read FAILED. Distinct from an
   *  empty map on purpose: only the second may unbind a camera (D49). */
  private async probeBindings(deviceId: number): Promise<OsdDeviceBindings | null> {
    try {
      return await this.deps.bindings(deviceId).get()
    } catch (err) {
      this.logger.warn(
        'osd-manager: binding read failed during reconcile — this camera keeps its index entry',
        { tags: { deviceId }, meta: { error: String(err) } },
      )
      return null
    }
  }

  // ── Cap methods ──────────────────────────────────────────────────

  getDeviceOsd = async ({
    deviceId,
  }: {
    deviceId: number
  }): Promise<{ supported: boolean; slots: OsdSlotView[] }> => {
    const status = await this.deps.readOsdStatus(deviceId)
    if (status === null) {
      this.logger.debug('osd-manager: camera publishes no osd cap', {
        tags: { deviceId },
      })
      return { supported: false, slots: [] }
    }
    const bindings = await this.readBindings(deviceId)
    const slots = status.overlays.map((overlay): OsdSlotView => {
      const binding = bindings[overlay.id] ?? null
      return {
        slotId: overlay.id,
        kind: overlay.kind,
        readOnly: overlay.readOnly === true,
        cameraEnabled: overlay.enabled,
        ...(overlay.text !== undefined ? { cameraText: overlay.text } : {}),
        binding,
      }
    })
    return { supported: true, slots }
  }

  getSourceCatalog = async ({
    deviceId,
  }: {
    deviceId: number
  }): Promise<{ sources: OsdSourceOption[] }> => {
    // UNFILTERED on purpose. A slot may render state from ANY device — the
    // picker's whole point is binding a sensor's value onto a camera's overlay
    // — so narrowing this to `isCamera: true` would answer with 30 rows out of
    // 1 019 and delete the feature. The cost that had to go was the ROUND
    // TRIPS, not the rows.
    const devices = await this.safeListDevices()
    const capsByDevice = await this.safeListDeviceCaps(deviceId, devices)
    return { sources: sourceOptionsFor(deviceId, devices, capsByDevice) }
  }

  getConditionSupport = async (): Promise<{
    supported: string[]
    catalog: NcConditionDescriptor[]
  }> => {
    return {
      supported: [...OSD_SUPPORTED_CONDITIONS],
      catalog: [...NC_CONDITION_CATALOG],
    }
  }

  setSlotBinding = async ({
    deviceId,
    slotId,
    binding,
  }: {
    deviceId: number
    slotId: string
    binding: OsdSlotBinding
  }): Promise<{ slot: OsdSlotView; render: OsdRenderResult }> => {
    // Refuse before persisting, not after: a stored binding whose gate can
    // never open renders a permanently blank overlay.
    assertSupportedConditions(binding.conditions)
    await this.assertSlotExists(deviceId, slotId)

    await this.deps.bindings(deviceId).update((prev) => withBinding(prev, slotId, binding))
    this.boundDevices.add(deviceId)
    // Same method as the binding write, immediately after it: the index can only
    // diverge if THIS write fails, and that failure is logged.
    await this.persistBoundIndex(deviceId)
    this.logger.info('osd-manager: slot binding saved', {
      tags: { deviceId },
      meta: { slotId, source: binding.source.kind },
    })

    const results = await this.renderDeviceInternal(deviceId, [slotId])
    const view = await this.getDeviceOsd({ deviceId })
    const slot = view.slots.find((s) => s.slotId === slotId)
    if (slot === undefined) {
      throw new Error(`osd-manager: slot "${slotId}" vanished from device ${deviceId} after save`)
    }
    const render = results[0] ?? {
      slotId,
      outcome: 'unbound' as const,
      text: '',
    }
    return { slot, render }
  }

  clearSlotBinding = async ({
    deviceId,
    slotId,
  }: {
    deviceId: number
    slotId: string
  }): Promise<{ success: true }> => {
    await this.deps.bindings(deviceId).update((prev) => withoutBinding(prev, slotId))
    this.lastWritten.delete(cacheKey(deviceId, slotId))
    const remaining = await this.readBindings(deviceId)
    if (Object.keys(remaining).length === 0) this.boundDevices.delete(deviceId)
    await this.persistBoundIndex(deviceId)
    this.logger.info('osd-manager: slot binding cleared — slot keeps its last text', {
      tags: { deviceId },
      meta: { slotId },
    })
    return { success: true }
  }

  setSlotCameraEnabled = async ({
    deviceId,
    slotId,
    enabled,
  }: {
    deviceId: number
    slotId: string
    enabled: boolean
  }): Promise<{ success: true }> => {
    await this.assertSlotExists(deviceId, slotId)
    await this.deps.writeOverlay(deviceId, slotId, { enabled })
    this.logger.info('osd-manager: camera overlay visibility set', {
      tags: { deviceId },
      meta: { slotId, enabled },
    })
    return { success: true }
  }

  copyDeviceConfiguration = async ({
    sourceDeviceId,
    targetDeviceId,
  }: {
    sourceDeviceId: number
    targetDeviceId: number
  }): Promise<{ copied: number; skipped: number }> => {
    if (sourceDeviceId === targetDeviceId) {
      throw new Error('osd-manager: source and target camera must be different')
    }
    const [sourceStatus, targetStatus, sourceBindings] = await Promise.all([
      this.deps.readOsdStatus(sourceDeviceId),
      this.deps.readOsdStatus(targetDeviceId),
      this.readBindings(sourceDeviceId),
    ])
    if (sourceStatus === null) {
      throw new Error(`osd-manager: source device ${sourceDeviceId} exposes no overlay slots`)
    }
    if (targetStatus === null) {
      throw new Error(`osd-manager: target device ${targetDeviceId} exposes no overlay slots`)
    }

    const sourceSlots = sourceStatus.overlays.filter(
      (slot) => slot.readOnly !== true && sourceBindings[slot.id] !== undefined,
    )
    if (sourceSlots.length === 0) {
      throw new Error(
        `osd-manager: source device ${sourceDeviceId} has no configured writable slots`,
      )
    }
    const targetSlots = targetStatus.overlays.filter((slot) => slot.readOnly !== true)
    const copiedBindings: OsdDeviceBindings = {}
    const copyCount = Math.min(sourceSlots.length, targetSlots.length)
    for (let index = 0; index < copyCount; index += 1) {
      const sourceSlot = sourceSlots[index]
      const targetSlot = targetSlots[index]
      if (sourceSlot === undefined || targetSlot === undefined) continue
      const binding = sourceBindings[sourceSlot.id]
      if (binding === undefined) continue
      const conditions = binding.conditions
      const normalizedConditions =
        conditions === undefined
          ? undefined
          : (() => {
              const { devices: _cameraScope, ...rest } = conditions
              return Object.keys(rest).length === 0 ? undefined : rest
            })()
      copiedBindings[targetSlot.id] = {
        ...binding,
        conditions: normalizedConditions,
      }
    }

    await this.deps.bindings(targetDeviceId).set(copiedBindings)
    for (const key of [...this.lastWritten.keys()]) {
      if (key.startsWith(`${targetDeviceId}:`)) this.lastWritten.delete(key)
    }
    if (Object.keys(copiedBindings).length > 0) this.boundDevices.add(targetDeviceId)
    else this.boundDevices.delete(targetDeviceId)
    await this.persistBoundIndex(targetDeviceId)
    await this.renderDeviceInternal(targetDeviceId, null)
    this.logger.info('osd-manager: camera configuration copied', {
      tags: { deviceId: targetDeviceId },
      meta: {
        sourceDeviceId,
        copied: Object.keys(copiedBindings).length,
        skipped: Math.max(0, sourceSlots.length - targetSlots.length),
      },
    })
    return {
      copied: Object.keys(copiedBindings).length,
      skipped: Math.max(0, sourceSlots.length - targetSlots.length),
    }
  }

  previewSlot = async ({
    deviceId,
    slotId,
    binding,
  }: {
    deviceId: number
    slotId: string
    binding?: OsdSlotBinding
  }): Promise<OsdRenderResult> => {
    if (binding !== undefined) assertSupportedConditions(binding.conditions)
    const effective = binding ?? (await this.readBindings(deviceId))[slotId] ?? null
    const facts = await this.collectFacts(
      deviceId,
      effective === null ? {} : { [slotId]: effective },
    )
    const maxCharacters = await this.maxCharactersForSlot(deviceId, slotId)
    // `previousText: undefined` on purpose — a preview must always report
    // what it WOULD write, never `unchanged`.
    return renderSlot(slotId, effective, deviceId, facts, undefined, maxCharacters)
  }

  renderDevice = async ({
    deviceId,
  }: {
    deviceId: number
  }): Promise<{ results: OsdRenderResult[] }> => {
    return { results: [...(await this.renderDeviceInternal(deviceId, null))] }
  }

  listTemplates = async (): Promise<{ templates: OsdNamedTemplate[] }> => {
    return { templates: [...(await this.deps.templates.get())] }
  }

  upsertTemplate = async ({
    template,
  }: {
    template: OsdNamedTemplate
  }): Promise<{ template: OsdNamedTemplate }> => {
    const prev = await this.deps.templates.get()
    const next = upsertNamedTemplate(prev, template)
    await this.deps.templates.set(next)
    const stored = findNamedTemplate(next, template.id)
    if (stored === undefined) {
      throw new Error(`osd-manager: template "${template.id}" missing after upsert`)
    }
    this.logger.info('osd-manager: named template upserted', {
      meta: { templateId: stored.id, bindingCount: stored.bindings.length },
    })
    return { template: stored }
  }

  deleteTemplate = async ({ templateId }: { templateId: string }): Promise<{ success: true }> => {
    const prev = await this.deps.templates.get()
    await this.deps.templates.set(deleteNamedTemplate(prev, templateId))
    this.logger.info('osd-manager: named template deleted', {
      meta: { templateId },
    })
    return { success: true }
  }

  // ── Render loop ──────────────────────────────────────────────────

  private async renderAllBound(): Promise<void> {
    for (const deviceId of [...this.boundDevices]) {
      try {
        await this.renderDeviceInternal(deviceId, null)
      } catch (err) {
        this.logger.warn('osd-manager: render pass failed', {
          tags: { deviceId },
          meta: { error: String(err) },
        })
      }
    }
  }

  /** Firmware text ceiling for one overlay, from the live `osd` status. */
  private async maxCharactersForSlot(
    deviceId: number,
    slotId: string,
  ): Promise<number | undefined> {
    const status = await this.deps.readOsdStatus(deviceId)
    return status?.overlays.find((o) => o.id === slotId)?.maxCharacters
  }

  /** Render (and write) `onlySlots`, or every bound slot when `null`. */
  private async renderDeviceInternal(
    deviceId: number,
    onlySlots: readonly string[] | null,
  ): Promise<readonly OsdRenderResult[]> {
    const bindings = await this.readBindings(deviceId)
    const slotIds = onlySlots ?? Object.keys(bindings)
    if (slotIds.length === 0) return []

    const facts = await this.collectFacts(deviceId, bindings)
    // One status read for the whole pass — each overlay's maxCharacters
    // lives on the device-scope `osd` cap, never on the binding.
    const status = await this.deps.readOsdStatus(deviceId)
    const maxBySlot = new Map<string, number>()
    for (const overlay of status?.overlays ?? []) {
      if (overlay.maxCharacters !== undefined) {
        maxBySlot.set(overlay.id, overlay.maxCharacters)
      }
    }
    const results: OsdRenderResult[] = []

    for (const slotId of slotIds) {
      const binding = bindings[slotId] ?? null
      const key = cacheKey(deviceId, slotId)
      const result = renderSlot(
        slotId,
        binding,
        deviceId,
        facts,
        this.lastWritten.get(key),
        maxBySlot.get(slotId),
      )
      results.push(result)

      if (result.outcome === 'unchanged') continue
      if (result.outcome === 'unbound' || result.outcome === 'disabled') continue

      try {
        // Do not force `enabled` from text — that overwrote the operator's
        // "Show on camera" choice (setSlotCameraEnabled). Binding off already
        // skips the write above (`disabled` / `unbound`). Always send `text`
        // so an empty render clears the firmware slot without toggling show.
        await this.deps.writeOverlay(deviceId, slotId, { text: result.text })
        this.lastWritten.set(key, result.text)
        this.logger.debug('osd-manager: slot written', {
          tags: { deviceId },
          meta: {
            slotId,
            outcome: result.outcome,
            text: result.text,
            reason: result.reason,
          },
        })
      } catch (err) {
        // Drop the memory so the next tick retries rather than believing
        // the camera carries text it rejected.
        this.lastWritten.delete(key)
        results[results.length - 1] = {
          slotId,
          outcome: 'failed',
          text: result.text,
          reason: String(err),
        }
        this.logger.warn('osd-manager: overlay write failed — will retry next tick', {
          tags: { deviceId },
          meta: { slotId, error: String(err) },
        })
      }
    }
    return results
  }

  /**
   * Read every device slice the bindings on this camera actually reference
   * — the camera itself, each source device, and each device named by a
   * `deviceState` gate. Nothing more: a cluster of 293 devices must not
   * cost 293 reads to render one overlay.
   */
  private async collectFacts(
    cameraDeviceId: number,
    bindings: OsdDeviceBindings,
  ): Promise<OsdFacts> {
    const wanted = new Set<number>([cameraDeviceId])
    const needsRecognition = Object.values(bindings).some(
      (binding) => binding.source.kind === 'latest-recognition',
    )
    const templateIds = new Set<string>()
    for (const binding of Object.values(bindings)) {
      if (binding.source.kind === 'device-state' && binding.source.deviceId !== undefined) {
        wanted.add(binding.source.deviceId)
      }
      if (binding.source.kind === 'template') templateIds.add(binding.source.templateId)
      const gated = binding.conditions?.deviceState?.deviceId
      if (gated !== undefined) wanted.add(gated)
    }

    const allTemplates = await this.deps.templates.get()
    const templatesById = new Map<string, OsdNamedTemplate>()
    for (const named of allTemplates) {
      templatesById.set(named.id, named)
      if (templateIds.has(named.id)) {
        for (const binding of named.bindings) wanted.add(binding.pick.deviceId)
      }
    }

    const stateByDevice = new Map<number, Readonly<Record<string, unknown>>>()
    const gateState = new Map<number, string>()
    for (const id of wanted) {
      try {
        const snapshot = await this.deps.readDeviceSnapshot(id)
        stateByDevice.set(id, snapshot)
        const collapsed = readDeviceStateFrom(snapshot)
        if (collapsed !== undefined) gateState.set(id, collapsed)
      } catch (err) {
        // Absent, never stale: a failed read must not look like a state.
        this.logger.debug('osd-manager: device-state read failed', {
          tags: { deviceId: id },
          meta: { error: String(err) },
        })
      }
    }

    if (needsRecognition) await this.hydrateRecognitions(cameraDeviceId)
    const recognitionByDevice = new Map<number, Readonly<{ person?: string; plate?: string }>>()
    const known = this.recognitions.get(cameraDeviceId)
    if (known !== undefined) {
      recognitionByDevice.set(cameraDeviceId, {
        ...(known.person !== undefined ? { person: known.person.text } : {}),
        ...(known.plate !== undefined ? { plate: known.plate.text } : {}),
      })
    }

    return {
      atMs: this.now(),
      stateByDevice,
      recognitionByDevice,
      deviceState: (id) => gateState.get(id),
      templatesById,
    }
  }

  private async hydrateRecognitions(deviceId: number): Promise<void> {
    const existing = this.recognitionHydration.get(deviceId)
    if (existing !== undefined) return existing
    const generation = this.recognitionGeneration.get(deviceId) ?? 0
    const hydration = (async () => {
      try {
        const latest = await this.deps.readLatestRecognitions(deviceId)
        if ((this.recognitionGeneration.get(deviceId) ?? 0) !== generation) return
        if (latest.person !== undefined) {
          this.mergeRecognition(deviceId, 'person', latest.person.text, latest.person.atMs)
        }
        if (latest.plate !== undefined) {
          this.mergeRecognition(deviceId, 'plate', latest.plate.text, latest.plate.atMs)
        }
      } catch (err) {
        this.logger.warn('osd-manager: recognition history hydration failed', {
          tags: { deviceId },
          meta: { error: String(err) },
        })
        this.recognitionHydration.delete(deviceId)
      }
    })()
    this.recognitionHydration.set(deviceId, hydration)
    await hydration
  }

  private mergeRecognition(
    deviceId: number,
    kind: RecognitionKind,
    text: string,
    atMs: number,
    trackFirstSeen?: number,
  ): boolean {
    const normalized = text.trim()
    if (normalized === '') return false
    const invalidatedAt = this.recognitionInvalidatedAt.get(deviceId)
    if (
      trackFirstSeen !== undefined &&
      invalidatedAt !== undefined &&
      trackFirstSeen <= invalidatedAt
    ) {
      return false
    }
    const current = this.recognitions.get(deviceId) ?? {}
    const previous = current[kind]
    if (previous !== undefined && previous.atMs > atMs) return false
    if (previous?.atMs === atMs && previous.text === normalized) return false
    this.recognitions.set(deviceId, {
      ...current,
      [kind]: { text: normalized, atMs },
    })
    return true
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private async readBindings(deviceId: number): Promise<OsdDeviceBindings> {
    try {
      return await this.deps.bindings(deviceId).get()
    } catch (err) {
      this.logger.warn('osd-manager: binding read failed — treating device as unbound', {
        tags: { deviceId },
        meta: { error: String(err) },
      })
      return EMPTY_BINDINGS
    }
  }

  /**
   * A binding for a slot the camera does not expose would never render and
   * would never say why. Refuse it, naming the slots that do exist.
   */
  private async assertSlotExists(deviceId: number, slotId: string): Promise<void> {
    const status = await this.deps.readOsdStatus(deviceId)
    if (status === null) {
      throw new Error(`osd-manager: device ${deviceId} exposes no overlay slots`)
    }
    const known = status.overlays.map((o) => o.id)
    if (!known.includes(slotId)) {
      throw new Error(
        `osd-manager: device ${deviceId} has no overlay slot "${slotId}". Slots: ${known.join(', ')}`,
      )
    }
    const overlay = status.overlays.find((o) => o.id === slotId)
    if (overlay?.readOnly === true) {
      throw new Error(
        `osd-manager: overlay slot "${slotId}" on device ${deviceId} is firmware-owned and cannot carry text`,
      )
    }
  }

  private async safeListDevices(): Promise<readonly OsdDeviceSummary[]> {
    try {
      return await this.deps.listDevices()
    } catch (err) {
      this.logger.warn('osd-manager: device listing failed', {
        meta: { error: String(err) },
      })
      return []
    }
  }

  /**
   * Every listed device's bound cap names, in ONE round trip.
   *
   * This used to be `listDeviceCaps(device.id)` inside the catalog loop, with a
   * per-device `catch` that omitted the device — 1 + 1 019 sequential
   * cross-process cap calls on the live hub 2026-08-30, behind an operator
   * opening a slot editor. The batch has no partial failure mode: it answers
   * for the whole set or it throws, and a throw lands where every per-device
   * read failing already landed — an empty map, hence a catalog with no
   * bindable sources. One log line instead of a thousand.
   *
   * `tags.deviceId` is the CAMERA whose editor is open, because that is the
   * question an operator asks ("why is 101's picker empty?"); the size of the
   * set that went unanswered rides in `meta`.
   */
  private async safeListDeviceCaps(
    cameraDeviceId: number,
    devices: readonly OsdDeviceSummary[],
  ): Promise<ReadonlyMap<number, readonly string[]>> {
    if (devices.length === 0) return new Map()
    try {
      return await this.deps.listDeviceCapsBatch(devices.map((d) => d.id))
    } catch (err) {
      this.logger.warn(
        'osd-manager: cap enumeration failed — the source catalog has no bindable values',
        {
          tags: { deviceId: cameraDeviceId },
          meta: { devices: devices.length, error: String(err) },
        },
      )
      return new Map()
    }
  }
}

function cacheKey(deviceId: number, slotId: string): string {
  return `${deviceId}:${slotId}`
}
