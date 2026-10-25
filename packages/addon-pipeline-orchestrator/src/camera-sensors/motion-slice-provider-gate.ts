/**
 * May the orchestrator write THIS camera's `motion` slice yet? The provider
 * half of the D696 writer gate (D696, amended 2026-10-02).
 *
 * `MotionSliceWriterGate` waits for every runner node to answer that it no
 * longer writes the slice. The runner was not the only pre-D696 writer: four
 * camera providers wrote it too — Hikvision and Amcrest raw on every VMD edge,
 * and all four (Hikvision, Amcrest, Reolink, Wyze) seeded `detected: false` at
 * every boot. `addon-pipeline` ships INSIDE `@camstack/server` (its closure is
 * re-aligned at boot, D518), so the runner always hands over at the server
 * step, before any provider step can run. With the runner gate alone, the
 * orchestrator then wrote every camera while the old providers still wrote
 * theirs: two writers, from the server step until the provider step.
 *
 * So, per CAMERA: a camera owned by one of those four providers is written
 * only once its provider has ANSWERED `deviceProvider.getStatus` with
 * `motionSliceWriter: 'orchestrator'`. Only the camera's OWN provider ever
 * wrote its slice, so the two-writer risk is per camera, and so is the gate:
 * an old Hikvision keeps the Hikvision cameras unwritten and nothing else.
 *
 * A camera's verdict:
 * - its owner is not one of the four ({@link PRE_D696_PROVIDER_SLICE_WRITERS}):
 *   no provider of it has ever written the slice — open;
 * - the owner answered with the field: it does not write — open;
 * - answered WITHOUT it: an old provider, which writes (`old-provider`, WARN);
 * - never answered: unknown, so closed (`unanswered`);
 * - its owner is not known yet (the camera list has not answered): closed
 *   (`owner-unknown`);
 * - the owner's process LEFT (`WorkerOffline`, the registry's positive word): it
 *   cannot write — open (`gone`), until it comes back.
 *
 * A read that fails changes nothing (D49). A provider process coming (back) up
 * (`WorkerOnline { '<node>/<addonId>' }`: a provider is its own runner, D29)
 * FORGETS that provider's answer before it can restore a device, so the gate
 * closes on its cameras and reopens only on a fresh answer — a rolled-back
 * provider is caught there. An answer from a census that began before the
 * provider's latest coming-up or leaving is older than that evidence and is
 * dropped (it may be the previous process speaking).
 *
 * The answers come from a census asked for by an event, never by a clock (D3):
 * boot, a process coming up or leaving, and a motion edge seen on a closed
 * camera (at most one per `PROVIDER_GATE_STALE_REFRESH_MS`).
 */
import type { IScopedLogger } from '@camstack/types'

/**
 * The camera providers that wrote a camera's `motion` slice before D696: raw
 * on every VMD edge (Hikvision, Amcrest) and a `detected: false` seed at every
 * boot (all four). D696 removed exactly these writes (no other provider ever
 * had one), and `scripts/check-onboard-motion-emitters.ts` refuses any new
 * one, so the set is closed: a provider outside it has never written the slice
 * in any version and needs no answer. Manifest addon ids.
 */
export const PRE_D696_PROVIDER_SLICE_WRITERS: ReadonlySet<string> = new Set([
  'provider-hikvision',
  'provider-amcrest',
  'provider-reolink',
  'provider-wyze',
])

/** A forget-and-reanswer flap is said on its first occurrence and every this-many-th after. */
const FLAP_SAY_EVERY = 20

/** A motion edge on a closed camera asks for a census at most this often. */
export const PROVIDER_GATE_STALE_REFRESH_MS = 30_000

/*
 * Keyed by ADDON id, not by node: the four providers are `placement: hub-only`
 * (their manifests), so one addon id is one process and
 * `deviceProvider.getStatus({ addonId })` reaches it. A provider that could run
 * on an agent would need its answers keyed by `(node, addonId)` — the
 * `WorkerOnline` id already carries the node.
 */

/** One camera and the addon that owns it (`deviceManager.listAll`). */
export interface CameraOwner {
  readonly id: number
  readonly addonId: string
}

export type CameraOwnersRead =
  | { readonly kind: 'rows'; readonly rows: readonly CameraOwner[] }
  | { readonly kind: 'unreadable'; readonly error: string }

/** A provider's `deviceProvider.getStatus`, as the gate reads it. */
export type ProviderSliceWriterRead =
  | { readonly kind: 'answered'; readonly motionSliceWriter: 'orchestrator' | null }
  | { readonly kind: 'unreadable'; readonly error: string }

/** Why a camera's slice is not written. */
export type CameraSliceBlock = 'owner-unknown' | 'old-provider' | 'unanswered'

export type CameraSliceVerdict =
  | { readonly open: true; readonly why: 'not-a-writer' | 'answered' | 'gone' }
  | { readonly open: false; readonly why: CameraSliceBlock }

/** Why a census was asked for (said on the gate lines). */
export type ProviderGateRefreshReason =
  | 'boot'
  | 'worker-online'
  | 'worker-offline'
  | 'agent-online'
  | 'motion-edge'
  | 'runner-census'

export interface ProviderSliceGateDeps {
  readonly logger: IScopedLogger
  readonly listCameraOwners: () => Promise<CameraOwnersRead>
  /** `deviceProvider.getStatus({ addonId })`; a throw is unanswered. */
  readonly readProviderStatus: (addonId: string) => Promise<ProviderSliceWriterRead>
  readonly now: () => number
  /** The cameras whose verdict moved, opened or closed. */
  readonly onChange: (deviceIds: readonly number[]) => void
}

function groupOf(processId: string): string | null {
  const slash = processId.indexOf('/')
  return slash === -1 ? null : processId.slice(slash + 1)
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class ProviderSliceGate {
  readonly #deps: ProviderSliceGateDeps
  /** Camera → the addon that owns it. */
  readonly #owners: Map<number, string> = new Map()
  /** Provider → `true` it answered that it does not write; `false` an old provider. */
  readonly #answers: Map<string, boolean> = new Map()
  /** Providers whose process the registry reported gone. */
  readonly #gone: Set<string> = new Set()
  /** Per provider: bumped on every coming-up or leaving; an answer read before it is dropped. */
  readonly #generation: Map<string, number> = new Map()
  /** The verdict last applied, per camera. */
  readonly #open: Map<number, boolean> = new Map()
  /** The line last said, per camera. */
  readonly #said: Map<number, string> = new Map()
  /** Per camera: how many times a FORGET closed it (`unanswered`) — the flap sampling (L2). */
  readonly #flaps: Map<number, number> = new Map()
  /** Cameras whose last flap close was not said: their reopen is not said either. */
  readonly #quietFlap: Set<number> = new Set()
  #inFlight: Promise<void> | null = null
  #again: ProviderGateRefreshReason | null = null
  #lastCensusAt: number | null = null

  constructor(deps: ProviderSliceGateDeps) {
    this.#deps = deps
  }

  isCameraOpen(deviceId: number): boolean {
    return this.verdictOf(deviceId).open
  }

  verdictOf(deviceId: number): CameraSliceVerdict {
    const owner = this.#owners.get(deviceId)
    if (owner === undefined) return { open: false, why: 'owner-unknown' }
    if (!PRE_D696_PROVIDER_SLICE_WRITERS.has(owner)) return { open: true, why: 'not-a-writer' }
    if (this.#gone.has(owner)) return { open: true, why: 'gone' }
    const answer = this.#answers.get(owner)
    if (answer === true) return { open: true, why: 'answered' }
    return { open: false, why: answer === false ? 'old-provider' : 'unanswered' }
  }

  /**
   * A process came up: `<node>/<group>` (a forked runner: a provider is its own
   * runner) or a bare node id (an agent reconnecting). The provider it is, or
   * for a bare node every provider, is forgotten and stops being gone: the gate
   * closes on its cameras before it can restore a device, and reopens only on a
   * fresh answer.
   */
  forgetProcess(processId: string): void {
    const group = groupOf(processId)
    const providers = group === null ? [...PRE_D696_PROVIDER_SLICE_WRITERS] : [group]
    for (const addonId of providers) {
      if (!PRE_D696_PROVIDER_SLICE_WRITERS.has(addonId)) continue
      this.#answers.delete(addonId)
      this.#gone.delete(addonId)
      this.#bump(addonId)
    }
    this.#reevaluate()
  }

  /** `WorkerOffline { '<node>/<addonId>' }`: the provider's process left, so it cannot write. */
  noteProcessGone(processId: string): void {
    const group = groupOf(processId)
    if (group === null || !PRE_D696_PROVIDER_SLICE_WRITERS.has(group)) return
    this.#answers.delete(group)
    this.#gone.add(group)
    this.#bump(group)
    this.#reevaluate()
  }

  /** Ask for a census now. One runs at a time; a request during it runs one more after it. */
  refresh(reason: ProviderGateRefreshReason): Promise<void> {
    if (this.#inFlight !== null) {
      this.#again = reason
      return this.#inFlight
    }
    this.#lastCensusAt = this.#deps.now()
    const run = this.#census(reason).finally(() => {
      this.#inFlight = null
      const again = this.#again
      this.#again = null
      if (again !== null) void this.refresh(again)
    })
    this.#inFlight = run
    return run
  }

  /**
   * A census, unless one ran within the window: on a motion edge of a closed
   * camera, and on every runner census — the bound on a dropped `WorkerOnline`.
   */
  refreshIfStale(reason: ProviderGateRefreshReason = 'motion-edge'): void {
    const last = this.#lastCensusAt
    if (last !== null && this.#deps.now() - last < PROVIDER_GATE_STALE_REFRESH_MS) return
    void this.refresh(reason)
  }

  async #census(reason: ProviderGateRefreshReason): Promise<void> {
    // The generations as of the census START: evidence that arrives while it
    // is in flight (a provider coming up or leaving) wins over its answer.
    const since = new Map(this.#generation)
    const owners = await this.#deps
      .listCameraOwners()
      .catch((err: unknown): CameraOwnersRead => ({ kind: 'unreadable', error: errMessage(err) }))
    if (owners.kind === 'rows') {
      this.#owners.clear()
      for (const row of owners.rows) this.#owners.set(row.id, row.addonId)
    } else {
      this.#deps.logger.warn(
        'camera motion slice: camera list unreadable — the provider gate keeps what it knew',
        { meta: { reason, error: owners.error } },
      )
    }
    const providers = [...new Set(this.#owners.values())].filter((a) =>
      PRE_D696_PROVIDER_SLICE_WRITERS.has(a),
    )
    const reads = await Promise.all(
      providers.map(async (addonId) => ({
        addonId,
        read: await this.#deps.readProviderStatus(addonId).catch(
          (err: unknown): ProviderSliceWriterRead => ({
            kind: 'unreadable',
            error: errMessage(err),
          }),
        ),
      })),
    )
    for (const { addonId, read } of reads) {
      if (read.kind === 'unreadable') {
        this.#deps.logger.debug(
          'camera motion slice: a camera provider did not answer — its cameras keep their verdict',
          { meta: { provider: addonId, reason, error: read.error } },
        )
        continue
      }
      if ((this.#generation.get(addonId) ?? 0) !== (since.get(addonId) ?? 0)) {
        this.#deps.logger.debug(
          'camera motion slice: a provider answer predates its latest coming-up or leaving — dropped',
          { meta: { provider: addonId, reason } },
        )
        continue
      }
      this.#answers.set(addonId, read.motionSliceWriter === 'orchestrator')
      this.#gone.delete(addonId)
    }
    this.#reevaluate()
  }

  #reevaluate(): void {
    const changed: number[] = []
    const ids = new Set([...this.#owners.keys(), ...this.#open.keys()])
    for (const deviceId of ids) {
      const verdict = this.verdictOf(deviceId)
      this.#say(deviceId, verdict)
      if (this.#open.get(deviceId) === verdict.open) continue
      this.#open.set(deviceId, verdict.open)
      changed.push(deviceId)
    }
    if (changed.length > 0) this.#deps.onChange(changed)
  }

  #say(deviceId: number, verdict: CameraSliceVerdict): void {
    const provider = this.#owners.get(deviceId) ?? null
    const signature = `${verdict.open}:${verdict.why}:${provider}`
    if (this.#said.get(deviceId) === signature) return
    const first = !this.#said.has(deviceId)
    this.#said.set(deviceId, signature)
    // A camera of a non-writer is open from its first listing: nothing to say.
    if (first && verdict.open && verdict.why === 'not-a-writer') return
    // A FLAP — forgotten on a (re)connect, then answered as before — is said on
    // its first occurrence and every `FLAP_SAY_EVERY`th after, per camera: an
    // agent reconnect forgets all four providers, so every one of their cameras
    // flaps with it (L2). An old provider or a gone one is never sampled away.
    if (!first && !verdict.open && verdict.why === 'unanswered') {
      const flaps = (this.#flaps.get(deviceId) ?? 0) + 1
      this.#flaps.set(deviceId, flaps)
      if (flaps > 1 && flaps % FLAP_SAY_EVERY !== 0) {
        this.#quietFlap.add(deviceId)
        return
      }
      this.#quietFlap.delete(deviceId)
    } else if (verdict.open && verdict.why === 'answered' && this.#quietFlap.delete(deviceId)) {
      return
    }
    const flaps = this.#flaps.get(deviceId)
    const extras = {
      tags: { deviceId },
      meta: { provider, why: verdict.why, ...(flaps === undefined ? {} : { flaps }) },
    }
    if (verdict.open) {
      this.#deps.logger.info(
        'camera motion slice: provider gate open for this camera — its provider does not write the slice',
        extras,
      )
      return
    }
    const line =
      'camera motion slice: provider gate closed for this camera — its provider may still write the slice'
    if (verdict.why === 'old-provider') this.#deps.logger.warn(line, extras)
    else this.#deps.logger.info(line, extras)
  }

  #bump(addonId: string): void {
    this.#generation.set(addonId, (this.#generation.get(addonId) ?? 0) + 1)
  }
}
