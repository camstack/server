/**
 * Alexa export sync engine.
 *
 * Replaces the fingerprint-diff / synced-account-latch machinery with four
 * explicit, verifiable push operations over a single persisted state map
 * (`exportedEndpoints`: deviceId → Alexa endpoint ids last sent). Each
 * operation pushes to ALL linked accounts and reports per-account failures;
 * `exportedEndpoints` is updated from the deterministically-built endpoint ids
 * so a later DeleteReport can always clean Alexa up — even after the device is
 * gone from the registry.
 */
import type { IScopedLogger } from '@camstack/types'
import { endpointsSignature } from './endpoint-signature.js'
import type { AlexaEndpoint } from './endpoints/types.js'
import { withholdInvalidEndpoints } from './endpoints/validate-endpoint.js'
import type { ExposedDeviceEntry, LinkedAccount } from './types.js'

export interface SyncEngineDeps {
  readonly logger: IScopedLogger
  readonly listExposed: () => readonly ExposedDeviceEntry[]
  readonly listLinkedAccounts: () => readonly LinkedAccount[]
  /** False when no LWA creds / no usable token — engine no-ops gracefully. */
  readonly hasProactiveCredentials: () => boolean
  /** Build the Alexa endpoints for one device (single path, no degraded gate). */
  readonly buildEndpoints: (deviceId: number) => Promise<readonly AlexaEndpoint[]>
  /**
   * The endpoints ONE linked account may be sent, shaped to what its hub user
   * may drive (S1, D767). `null` when that user's grants cannot be read right
   * now — the account is then skipped, never sent the unfiltered set.
   */
  readonly filterForAccount: (
    userId: string,
    endpoints: readonly AlexaEndpoint[],
  ) => Promise<readonly AlexaEndpoint[] | null>
  /** POST an AddOrUpdateReport to one account. Returns true on gateway 2xx. */
  readonly postAddOrUpdate: (
    userId: string,
    endpoints: readonly AlexaEndpoint[],
  ) => Promise<boolean>
  /**
   * Endpoints just accepted for an account. The addon reports their initial
   * `Alexa.EndpointHealth` connectivity from here (D770): Alexa must never hold
   * an endpoint of unknown health.
   */
  readonly afterPush: (userId: string, endpoints: readonly AlexaEndpoint[]) => void
  /**
   * Whether an endpoint id the device no longer builds may be DELETED from
   * Alexa on a push. True only for endpoints whose presence is decided by a
   * setting or a read that never flips on a transient failure (the detection
   * sensors).
   */
  readonly mayRetire: (endpointId: string) => boolean
  /** POST a DeleteReport to one account. Returns true on gateway 2xx. */
  readonly postDelete: (userId: string, endpointIds: readonly string[]) => Promise<boolean>
  readonly getExportedEndpoints: () => Readonly<Record<number, readonly string[]>>
  readonly setExportedEndpoints: (
    next: Readonly<Record<number, readonly string[]>>,
  ) => Promise<void>
  /** deviceId → the endpoint SHAPE we last pushed (see `endpoint-signature.ts`).
   *  The reconcile's only discriminator: Alexa's cloud copy is refreshed by
   *  nothing but our own AddOrUpdateReport, so this is what tells us whether
   *  Amazon still believes the pre-binding shape. */
  readonly getExportedSignatures: () => Readonly<Record<number, string>>
  readonly setExportedSignatures: (next: Readonly<Record<number, string>>) => Promise<void>
}

export interface PushResult {
  readonly deviceCount: number
  readonly endpointCount: number
  readonly accountCount: number
  /** `${userId}:${deviceId}` tuples whose AddOrUpdate post failed. */
  readonly failures: readonly string[]
}

/** Outcome of the operator's Re-sync: the forced push plus the cleanup of
 *  devices that are tracked but no longer exposed. Object-literal type so it
 *  satisfies the action handler's `Record<string, unknown>` contract. */
export type ResyncResult = {
  readonly deviceCount: number
  readonly endpointCount: number
  readonly accountCount: number
  /** Endpoint ids of unexposed devices every account accepted a delete for. */
  readonly removedEndpointCount: number
  /** Endpoint ids of unexposed devices still tracked, because a delete failed
   *  or there is no account to send it to. The next Re-sync retries them. */
  readonly retainedEndpointCount: number
  /** Gateway posts that failed (pushes and deletes). */
  readonly failedCount: number
}

export interface RemoveResult {
  readonly deviceId: number
  readonly endpointCount: number
  readonly accountCount: number
  readonly failures: readonly string[]
}

function declaresObjectDetection(endpoint: AlexaEndpoint): boolean {
  return endpoint.capabilities.some(
    (c) => c.interface === 'Alexa.SmartVision.ObjectDetectionSensor',
  )
}

/** Outcome of a single-device drift reconcile. */
export interface ReconcileResult {
  readonly deviceId: number
  /** True when the built shape disagreed with the last pushed signature and an
   *  AddOrUpdateReport went out. */
  readonly pushed: boolean
}

/** Outcome of a full reconcile pass over the exposed set. */
export interface ReconcileAllResult {
  readonly checkedDeviceIds: readonly number[]
  readonly pushedDeviceIds: readonly number[]
}

/**
 * Devices reconciled at once in {@link SyncEngine.reconcileAllExposed}. Each
 * lane's device build is a handful of cross-process tRPC calls — latency, not
 * CPU — so four lanes hide most of it without turning a boot-time cap
 * registration burst into a second stampede.
 */
const RECONCILE_ALL_CONCURRENCY = 4

export class SyncEngine {
  /**
   * Serializes the `recordEndpoints` read-modify-write. The build/push half of
   * a reconcile runs parallel across devices, but the persisted maps are
   * whole-object snapshots: two concurrent `get → mutate → set` cycles would
   * silently drop one device's ids/signature (last writer wins).
   */
  private recordChain: Promise<void> = Promise.resolve()

  /**
   * One in-flight reconcile per device. At boot the 60 s full pass and the
   * debounced bindings-change reconciles overlap, and each one rebuilt the
   * same device serially — the live hub built camera 101's endpoint shape
   * four times inside one boot (2026-08-15). Joining the running pass costs
   * the duplicate nothing.
   */
  private readonly reconcileFlights = new Map<number, Promise<ReconcileResult>>()

  constructor(private readonly deps: SyncEngineDeps) {}

  async pushDevice(deviceId: number): Promise<PushResult> {
    const accounts = this.deps.listLinkedAccounts()
    if (accounts.length === 0 || !this.deps.hasProactiveCredentials()) {
      return { deviceCount: 0, endpointCount: 0, accountCount: accounts.length, failures: [] }
    }
    const endpoints = await this.deps.buildEndpoints(deviceId)
    if (endpoints.length === 0) {
      // An empty AddOrUpdateReport is an Alexa protocol error — never post it.
      // Clear any stale stored ids so a later DeleteReport doesn't address
      // endpoints we no longer build.
      await this.recordEndpoints(deviceId, [], null)
      return { deviceCount: 0, endpointCount: 0, accountCount: accounts.length, failures: [] }
    }
    const endpointIds = endpoints.map((e) => e.endpointId)
    // Endpoints this device published before and no longer builds — a
    // detection sensor switched off. AddOrUpdateReport never removes anything,
    // so without a DeleteReport they would linger in every Alexa account.
    // Only ids `mayRetire` accepts: an endpoint whose absence can come from a
    // transient read (an accessory behind a failed `getChildren`) is never
    // deleted on one build, because a DeleteReport destroys the user's
    // routines (D49).
    const retired = (this.deps.getExportedEndpoints()[deviceId] ?? []).filter(
      (id) => !endpointIds.includes(id) && this.deps.mayRetire(id),
    )
    const failures: string[] = []
    for (const account of accounts) {
      const ok = await this.postFiltered(account.userId, deviceId, endpoints)
      if (!ok) failures.push(`${account.userId}:${deviceId}`)
      if (retired.length > 0) {
        const deleted = await this.deps.postDelete(account.userId, retired)
        if (!deleted) failures.push(`${account.userId}:${deviceId}:delete`)
      }
    }
    if (retired.length > 0) {
      this.deps.logger.info('alexa sync: retired endpoints the device no longer builds', {
        tags: { deviceId },
        meta: { retired },
      })
    }
    // Record the (deterministic) endpoint ids regardless of per-account post
    // success: they are what we attempted to put in Alexa, and a later
    // DeleteReport must be able to address them even if a transient post failed.
    await this.recordEndpoints(deviceId, endpointIds, endpointsSignature(endpoints))
    return {
      deviceCount: 1, // guaranteed non-empty here (empty handled above)
      endpointCount: endpoints.length,
      accountCount: accounts.length,
      failures,
    }
  }

  async pushAllExposed(): Promise<PushResult> {
    const accounts = this.deps.listLinkedAccounts()
    // Early no-op so the result reports the accurate accountCount (incl. zero
    // accounts). pushDevice re-checks both guards per device — the layering is
    // intentional, not redundant: a single snapshot here would drift if state
    // changed mid-loop.
    if (accounts.length === 0 || !this.deps.hasProactiveCredentials()) {
      return { deviceCount: 0, endpointCount: 0, accountCount: accounts.length, failures: [] }
    }
    let deviceCount = 0
    let endpointCount = 0
    const failures: string[] = []
    for (const { deviceId } of this.deps.listExposed()) {
      const r = await this.pushDevice(deviceId)
      deviceCount += r.deviceCount
      endpointCount += r.endpointCount
      failures.push(...r.failures)
    }
    return { deviceCount, endpointCount, accountCount: accounts.length, failures }
  }

  async pushAllToAccount(userId: string): Promise<PushResult> {
    if (!this.deps.hasProactiveCredentials()) {
      return { deviceCount: 0, endpointCount: 0, accountCount: 0, failures: [] }
    }
    let deviceCount = 0
    let endpointCount = 0
    const failures: string[] = []
    for (const { deviceId } of this.deps.listExposed()) {
      const endpoints = await this.deps.buildEndpoints(deviceId)
      // Mirror pushDevice's empty-endpoint handling: never post an empty
      // AddOrUpdateReport (Alexa protocol error). Here the device is simply
      // skipped for this single-account push.
      if (endpoints.length === 0) continue
      const ok = await this.postFiltered(userId, deviceId, endpoints)
      if (!ok) failures.push(`${userId}:${deviceId}`)
      await this.recordEndpoints(
        deviceId,
        endpoints.map((e) => e.endpointId),
        endpointsSignature(endpoints),
      )
      deviceCount += 1
      endpointCount += endpoints.length
    }
    // accountCount: 1 is intentional — this is a deliberate single-account push.
    return { deviceCount, endpointCount, accountCount: 1, failures }
  }

  /**
   * Post `endpoints` to one account, cut to what that account's user may see.
   * Nothing visible is a success with nothing to send: an empty
   * AddOrUpdateReport is an Alexa protocol error.
   */
  private async postFiltered(
    userId: string,
    deviceId: number,
    endpoints: readonly AlexaEndpoint[],
  ): Promise<boolean> {
    const filtered = await this.deps.filterForAccount(userId, endpoints)
    if (filtered === null) {
      this.deps.logger.warn(
        "alexa sync: the linked user's grants could not be read — this account was NOT sent the device",
        { tags: { deviceId }, meta: { userId } },
      )
      return false
    }
    const visible = withholdInvalidEndpoints(filtered, (message, violations) => {
      this.deps.logger.warn(message, { tags: { deviceId }, meta: { userId, violations } })
    })
    if (visible.length === 0) return true
    // R4 (D779): a camera declaring the SmartVision object-detection interface
    // travels ALONE. Amazon once rejected a SmartVision camera together with
    // every child in the same report; isolated, a rejection costs that one
    // endpoint, and its gateway answer is its own line in the log.
    const isolated = visible.filter(declaresObjectDetection)
    const rest = visible.filter((e) => !declaresObjectDetection(e))
    let allOk = true
    for (const batch of [...isolated.map((e) => [e]), ...(rest.length > 0 ? [rest] : [])]) {
      const ok = await this.deps.postAddOrUpdate(userId, batch)
      for (const endpoint of batch) {
        this.deps.logger.info('alexa sync: AddOrUpdateReport endpoint result', {
          tags: { deviceId },
          meta: {
            userId,
            endpointId: endpoint.endpointId,
            gatewayAccepted: ok,
            isolated: batch.length === 1 && isolated.includes(endpoint),
            interfaces: endpoint.capabilities.map((c) =>
              c.instance === undefined ? c.interface : `${c.interface}#${c.instance}`,
            ),
          },
        })
      }
      if (ok) this.deps.afterPush(userId, batch)
      else allOk = false
    }
    return allOk
  }

  /** A device the account's user just gained (visibility mirror). */
  async pushDeviceToAccount(userId: string, deviceId: number): Promise<boolean> {
    if (!this.deps.hasProactiveCredentials()) return false
    if (!this.deps.listExposed().some((e) => e.deviceId === deviceId)) return true
    const endpoints = await this.deps.buildEndpoints(deviceId)
    if (endpoints.length === 0) return false
    return this.postFiltered(userId, deviceId, endpoints)
  }

  /** A device the account's user lost (confirmed by two reads): delete every
   *  endpoint we ever published for it from THAT account only. */
  async removeDeviceFromAccount(userId: string, deviceId: number): Promise<boolean> {
    if (!this.deps.hasProactiveCredentials()) return false
    const ids = this.deps.getExportedEndpoints()[deviceId] ?? [String(deviceId)]
    return this.deps.postDelete(userId, ids)
  }

  async removeDevice(deviceId: number): Promise<RemoveResult> {
    const ids = this.deps.getExportedEndpoints()[deviceId] ?? []
    if (ids.length === 0) {
      // Nothing tracked for this device — the key isn't present, so a persist
      // write would be wasteful. Return without touching storage.
      return { deviceId, endpointCount: 0, accountCount: 0, failures: [] }
    }
    const accounts = this.deps.listLinkedAccounts()
    const failures: string[] = []
    for (const account of accounts) {
      const ok = await this.deps.postDelete(account.userId, ids)
      if (!ok) failures.push(`${account.userId}:${deviceId}`)
    }
    // Forget the ids only once every account accepted the delete. Forgetting
    // them after a failure is how ghosts used to appear: Alexa kept the
    // endpoint and nothing here remembered it, so no later run could remove it.
    if (failures.length === 0) await this.recordEndpoints(deviceId, [], null)
    return { deviceId, endpointCount: ids.length, accountCount: accounts.length, failures }
  }

  /**
   * The operator's Re-sync: re-send every exposed device (whatever the
   * signatures say), then delete from Alexa every device we still track but no
   * longer expose — an unexpose whose DeleteReport failed.
   *
   * Only devices ABSENT from the exposed list are deleted. That list is the
   * operator's persisted choice, not a read that can fail transiently; what an
   * exposed device happens not to build this time is never deleted here
   * (D49 / D767).
   */
  async resync(): Promise<ResyncResult> {
    const push = await this.pushAllExposed()
    const exposed = new Set(this.deps.listExposed().map((e) => e.deviceId))
    const unexposed = Object.entries(this.deps.getExportedEndpoints())
      .map(([key, ids]) => ({ deviceId: Number(key), ids }))
      .filter((entry) => !exposed.has(entry.deviceId) && entry.ids.length > 0)
    const canDelete = push.accountCount > 0 && this.deps.hasProactiveCredentials()
    let removedEndpointCount = 0
    let retainedEndpointCount = 0
    let failedCount = push.failures.length
    for (const { deviceId, ids } of unexposed) {
      if (!canDelete) {
        retainedEndpointCount += ids.length
        continue
      }
      const r = await this.removeDevice(deviceId)
      failedCount += r.failures.length
      if (r.failures.length === 0) removedEndpointCount += ids.length
      else retainedEndpointCount += ids.length
    }
    if (unexposed.length > 0) {
      this.deps.logger.info('alexa sync: re-sync cleaned up devices that are no longer exposed', {
        meta: {
          deviceIds: unexposed.map((u) => u.deviceId),
          removedEndpointCount,
          retainedEndpointCount,
        },
      })
    }
    return {
      deviceCount: push.deviceCount,
      endpointCount: push.endpointCount,
      accountCount: push.accountCount,
      removedEndpointCount,
      retainedEndpointCount,
      failedCount,
    }
  }

  // ── Drift reconcile ─────────────────────────────────────────────
  //
  // Every other operation here is triggered by an OPERATOR action. None of
  // them fires when a camera's capability bindings change, and Alexa's copy
  // of an endpoint is refreshed by nothing else — so a camera that gains the
  // `doorbell` cap after it was exposed keeps a cloud-side shape with no
  // `Alexa.DoorbellEventSource` forever. The Event Gateway then answers 2xx
  // to every DoorbellPress and the cloud discards it: the push logs success
  // and the Echo stays silent. That is the 2026-08-07 camera-101 failure.
  //
  // The reconcile closes it by comparing the shape we would build NOW against
  // the shape we last pushed. It is cheap enough to run on every
  // bindings-change and at boot: an unchanged shape performs zero gateway
  // calls and zero writes.

  /**
   * Re-push ONE exposed device if the endpoint shape it builds today differs
   * from the shape Alexa was last told about.
   *
   * A build that yields NO endpoints (transient registry miss) is never
   * pushed — an empty AddOrUpdateReport is an Alexa protocol error — and never
   * clears the recorded signature: forgetting it would make the next reconcile
   * re-push a shape Alexa already has.
   */
  async reconcileDevice(deviceId: number): Promise<ReconcileResult> {
    const inFlight = this.reconcileFlights.get(deviceId)
    if (inFlight) return inFlight
    const flight = this.reconcileDeviceNow(deviceId).finally(() => {
      if (this.reconcileFlights.get(deviceId) === flight) this.reconcileFlights.delete(deviceId)
    })
    this.reconcileFlights.set(deviceId, flight)
    return flight
  }

  private async reconcileDeviceNow(deviceId: number): Promise<ReconcileResult> {
    if (!this.deps.listExposed().some((e) => e.deviceId === deviceId)) {
      return { deviceId, pushed: false }
    }
    if (this.deps.listLinkedAccounts().length === 0 || !this.deps.hasProactiveCredentials()) {
      return { deviceId, pushed: false }
    }
    const endpoints = await this.deps.buildEndpoints(deviceId)
    if (endpoints.length === 0) {
      this.deps.logger.warn(
        'alexa sync: reconcile built ZERO endpoints — leaving Alexa untouched (transient registry miss)',
        { tags: { deviceId } },
      )
      return { deviceId, pushed: false }
    }
    const current = endpointsSignature(endpoints)
    const last = this.deps.getExportedSignatures()[deviceId]
    if (last === current) return { deviceId, pushed: false }

    this.deps.logger.info(
      'alexa sync: endpoint shape drifted — re-pushing AddOrUpdateReport so the cloud advertises the current interfaces',
      {
        tags: { deviceId },
        meta: {
          from: last ?? 'never-recorded',
          to: current,
          interfaces: endpoints.flatMap((e) => e.capabilities.map((c) => c.interface)),
        },
      },
    )
    await this.pushDevice(deviceId)
    return { deviceId, pushed: true }
  }

  /** Reconcile every exposed device (boot pass + manual safety net). */
  async reconcileAllExposed(): Promise<ReconcileAllResult> {
    const checkedDeviceIds: number[] = []
    const pushedDeviceIds: number[] = []
    // Bounded-parallel: each device build is 3–5 cross-process tRPC calls
    // (getDevice → getBindings → getChildren [→ ptz.getPresets, per-child
    // getBindings]), and at boot those round-trips contend with runner spawns
    // and cost seconds apiece — serially, a 21-camera exposed list took
    // minutes (live hub, 2026-08-15). Devices are independent; only the
    // persisted-state write is serialized (see `recordEndpoints`).
    const queue = [...this.deps.listExposed()]
    const lane = async (): Promise<void> => {
      for (;;) {
        const entry = queue.shift()
        if (entry === undefined) return
        checkedDeviceIds.push(entry.deviceId)
        const r = await this.reconcileDevice(entry.deviceId)
        if (r.pushed) pushedDeviceIds.push(entry.deviceId)
      }
    }
    const lanes = Math.min(RECONCILE_ALL_CONCURRENCY, Math.max(1, queue.length))
    await Promise.all(Array.from({ length: lanes }, lane))
    return { checkedDeviceIds, pushedDeviceIds }
  }

  /** Persist the endpoint ids AND the shape signature for a device.
   *  `signature === null` forgets both (delete / empty build).
   *
   *  Serialized through `recordChain`: the maps are whole-object snapshots
   *  (`get` → spread → `set`), so parallel reconciles would otherwise race —
   *  two devices' writes computed off the same stale snapshot, the second
   *  `set` erasing the first's entry. */
  private async recordEndpoints(
    deviceId: number,
    ids: readonly string[],
    signature: string | null,
  ): Promise<void> {
    const write = this.recordChain.then(async () => {
      const next = { ...this.deps.getExportedEndpoints() }
      if (ids.length > 0) next[deviceId] = ids
      else delete next[deviceId]
      await this.deps.setExportedEndpoints(next)

      const nextSignatures = { ...this.deps.getExportedSignatures() }
      if (signature !== null) nextSignatures[deviceId] = signature
      else delete nextSignatures[deviceId]
      await this.deps.setExportedSignatures(nextSignatures)
    })
    // Keep the chain alive (never rejected) while letting the caller see a
    // real failure.
    this.recordChain = write.then(
      () => undefined,
      () => undefined,
    )
    return write
  }
}
