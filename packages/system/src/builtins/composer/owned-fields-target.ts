/**
 * The write target of a composition on an EXISTING device (D663): its fields
 * are CLAIMED on the hub (`deviceState.claimFields`), then patched
 * (`patchOwnedFields`). The runtime's `seed`/`patch` are synchronous and never
 * fail here — the RPC is enqueued — so what did not land is reported through
 * `onAsyncFailure`, and the runtime marks the cap write-pending and re-writes
 * it whole on its next pass. No retry timer (D3).
 *
 * - **The claim is re-sent until it has LANDED (ruling S5).** A cap enters
 *   `landed` only on an `ok` claim answer. Every write of a cap not in `landed`
 *   is a claim carrying the FULL planned field set (`fieldsOf`, never inferred
 *   from the values). `not-claimed` / `field-not-claimed` — the hub lost or
 *   never had the claim — drop the cap from `landed` and are escalated by
 *   name, so the next write claims again.
 * - **Concurrent partial patches are MERGED, never dropped (S5).** One chain
 *   per cap: while an RPC is in flight, later patches fold into one pending
 *   value set (later keys win; a seed replaces it wholly), and the landing log
 *   says how many were absorbed (D391).
 * - **A released field is withheld (S1b).** `withhold(cap, fields)` narrows the
 *   next claim to the rest and omits their values; nothing left → the claim is
 *   released at once. `[]` re-widens.
 * - **Every claim RPC of a `replace` cap is reported** (`onClaim`, C-1/N-1):
 *   `claiming` when it goes out, then `held` on an `ok`, `free` on a confirmed
 *   release or `not-claimed`, `unsettled` on a throw or any other refusal (D49:
 *   changes nothing). `field-not-claimed` on a patch drops `landed` so the next
 *   write claims again, but the hub still holds the claim: `held` stays (N-3).
 *   The tracker follows this — never the plan — to know whether
 *   `device.state-changed` of the cap is the provider's native, the
 *   composition's own merge, or (while a claim is in flight) neither.
 * - `setAvailable` is a no-op: `device-status` is the native device's.
 */
import {
  type ClaimOutcome,
  type deviceStateCapability,
  errMsg,
  type FieldClaimMode,
  type IScopedLogger,
} from '@camstack/types'
import type { z } from 'zod'
import type {
  ComposedWriteTarget,
  TargetAsyncFailure,
  WriteOutcome,
} from './composition-runtime.js'
import type { ClaimEvent } from './held-claims.js'
import type { SlicePatch } from './slice-assembler.js'

export type ClaimFieldsInput = z.infer<typeof deviceStateCapability.methods.claimFields.input>
export type PatchOwnedFieldsInput = z.infer<
  typeof deviceStateCapability.methods.patchOwnedFields.input
>
export type ReleaseClaimInput = z.infer<typeof deviceStateCapability.methods.releaseClaim.input>

export interface OwnedFieldsApi {
  claimFields(input: ClaimFieldsInput): Promise<ClaimOutcome>
  patchOwnedFields(input: PatchOwnedFieldsInput): Promise<ClaimOutcome>
  releaseClaim(input: ReleaseClaimInput): Promise<ClaimOutcome>
}

export interface OwnedFieldsTargetDeps {
  readonly deviceId: number
  readonly owner: string
  readonly modeOf: (cap: string) => FieldClaimMode
  /** The PLANNED field set per cap, from the plan — sent on every claim, never inferred from values (S5). */
  readonly fieldsOf: (cap: string) => readonly string[]
  readonly api: OwnedFieldsApi
  readonly logger: IScopedLogger
  /** A claim RPC of this owner on a `replace` cap went out or was answered (see the header). */
  readonly onClaim?: (cap: string, event: ClaimEvent) => void
}

type WriteOp = 'seed' | 'patch'

interface PendingWrite {
  readonly kind: 'write'
  readonly op: WriteOp
  readonly values: SlicePatch
  /** Writes folded into this one while another was in flight. */
  readonly merged: number
}
interface PendingRelease {
  readonly kind: 'release'
}
type PendingOp = PendingWrite | PendingRelease

type AsyncFailureListener = (cap: string, failure: TargetAsyncFailure) => void

const ACCEPTED: WriteOutcome = { ok: true }

/** The hub has no claim to patch: the next write must claim again. */
const CLAIM_LOST_CODES: ReadonlySet<string> = new Set(['not-claimed', 'field-not-claimed'])

/**
 * Later keys win; a seed replaces the pending values wholly; a release
 * supersedes any pending values (nothing is left to write) and is itself
 * superseded by a later write (a claim REPLACES the hub's field set anyway).
 */
function fold(current: PendingOp | undefined, next: PendingOp): PendingOp {
  if (current === undefined || next.kind === 'release' || current.kind === 'release') return next
  if (next.op === 'seed') return { ...next, merged: current.merged + 1 }
  return {
    kind: 'write',
    op: current.op,
    values: { ...current.values, ...next.values },
    merged: current.merged + 1,
  }
}

function omitKeys(values: SlicePatch, keys: ReadonlySet<string> | undefined): SlicePatch {
  if (keys === undefined || keys.size === 0) return values
  return Object.fromEntries(Object.entries(values).filter(([key]) => !keys.has(key)))
}

export class OwnedFieldsTarget implements ComposedWriteTarget {
  readonly id: number
  private landed: ReadonlySet<string> = new Set()
  private withheld: ReadonlyMap<string, ReadonlySet<string>> = new Map()
  private inFlight: ReadonlySet<string> = new Set()
  private pending: ReadonlyMap<string, PendingOp> = new Map()
  private listeners: readonly AsyncFailureListener[] = []
  /** Per cap, bumped by every `withhold`: a claim that settles under another epoch claimed a stale field set and does not land (I-2). */
  private epoch: ReadonlyMap<string, number> = new Map()
  /** Set by `quiesce`: nothing further is sent. */
  private closed = false
  private idle: Promise<void> = Promise.resolve()
  private markIdle: (() => void) | null = null

  constructor(private readonly deps: OwnedFieldsTargetDeps) {
    this.id = deps.deviceId
  }

  seed(cap: string, slice: SlicePatch): WriteOutcome {
    this.enqueue(cap, { kind: 'write', op: 'seed', values: slice, merged: 0 })
    return ACCEPTED
  }

  patch(cap: string, patch: SlicePatch): WriteOutcome {
    this.enqueue(cap, { kind: 'write', op: 'patch', values: patch, merged: 0 })
    return ACCEPTED
  }

  /** `device-status` belongs to the native device; availability lives in the block report only. */
  setAvailable(_available: boolean): void {}

  /**
   * The block has stopped. Writes still queued are dropped; the call in flight
   * is allowed to finish, and then nothing else is sent.
   */
  quiesce(): Promise<void> {
    this.closed = true
    const dropped = [...this.pending.keys()]
    this.pending = new Map()
    for (const cap of dropped) {
      this.deps.logger.info('composed write dropped — the block stopped before it was sent', {
        tags: { deviceId: this.deps.deviceId },
        meta: { cap, owner: this.deps.owner },
      })
    }
    if (this.inFlight.size === 0) return Promise.resolve()
    if (this.markIdle === null) {
      this.idle = new Promise((resolve) => {
        this.markIdle = resolve
      })
    }
    return this.idle
  }

  onAsyncFailure(listener: AsyncFailureListener): void {
    this.listeners = [...this.listeners, listener]
  }

  withhold(cap: string, fields: readonly string[]): WriteOutcome {
    this.withheld = new Map(
      [...this.withheld.entries()]
        .filter(([c]) => c !== cap)
        .concat(fields.length === 0 ? [] : [[cap, new Set(fields)]]),
    )
    // The next write is a CLAIM over the narrowed set — and a claim already in
    // flight carries the OLD set, so its landing must not count.
    this.landed = new Set([...this.landed].filter((c) => c !== cap))
    this.epoch = new Map([...this.epoch, [cap, (this.epoch.get(cap) ?? 0) + 1]])
    if (this.claimableFields(cap).length === 0) this.enqueue(cap, { kind: 'release' })
    return ACCEPTED
  }

  private claimableFields(cap: string): readonly string[] {
    const held = this.withheld.get(cap)
    return this.deps.fieldsOf(cap).filter((f) => held === undefined || !held.has(f))
  }

  private enqueue(cap: string, op: PendingOp): void {
    if (this.closed) {
      this.deps.logger.info('composed write dropped — the block stopped before it was sent', {
        tags: { deviceId: this.deps.deviceId },
        meta: { cap, owner: this.deps.owner, op: op.kind },
      })
      return
    }
    if (!this.inFlight.has(cap)) {
      this.send(cap, op)
      return
    }
    this.pending = new Map([...this.pending, [cap, fold(this.pending.get(cap), op)]])
  }

  private send(cap: string, op: PendingOp): void {
    this.inFlight = new Set([...this.inFlight, cap])
    const run = op.kind === 'release' ? this.sendRelease(cap) : this.sendWrite(cap, op)
    void run.then(
      () => this.settled(cap),
      (err: unknown) => {
        // `sendWrite`/`sendRelease` catch their RPC; only a listener can throw here.
        this.deps.logger.error(
          'composed write chain threw past its handlers — the chain continues',
          {
            tags: { deviceId: this.deps.deviceId },
            meta: { cap, owner: this.deps.owner, error: errMsg(err) },
          },
        )
        this.settled(cap)
      },
    )
  }

  private settled(cap: string): void {
    this.inFlight = new Set([...this.inFlight].filter((c) => c !== cap))
    if (this.closed) {
      this.pending = new Map()
      if (this.inFlight.size === 0) this.markIdle?.()
      return
    }
    const next = this.pending.get(cap)
    if (next === undefined) return
    this.pending = new Map([...this.pending].filter(([c]) => c !== cap))
    this.send(cap, next)
  }

  private async sendWrite(cap: string, op: PendingWrite): Promise<void> {
    const values = omitKeys(op.values, this.withheld.get(cap))
    const claim = !this.landed.has(cap)
    const fields = this.claimableFields(cap)
    const epoch = this.epoch.get(cap) ?? 0
    if (claim && fields.length === 0) {
      this.deps.logger.debug('composed write skipped — every field of the capability is withheld', {
        tags: { deviceId: this.deps.deviceId },
        meta: { cap, owner: this.deps.owner, op: op.op },
      })
      return
    }
    if (!claim && Object.keys(values).length === 0) return
    if (claim) this.report(cap, 'claiming')
    let outcome: ClaimOutcome
    try {
      outcome = claim
        ? await this.deps.api.claimFields({
            deviceId: this.deps.deviceId,
            capName: cap,
            owner: this.deps.owner,
            mode: this.deps.modeOf(cap),
            fields: [...fields],
            values,
          })
        : await this.deps.api.patchOwnedFields({
            deviceId: this.deps.deviceId,
            capName: cap,
            owner: this.deps.owner,
            values,
          })
    } catch (err: unknown) {
      if (claim) this.report(cap, 'unsettled')
      this.fail(cap, { kind: 'threw', error: errMsg(err) })
      return
    }
    if (outcome.ok) {
      // The hub holds a claim now, whatever field set it carries.
      if (claim) this.report(cap, 'held')
      const current = (this.epoch.get(cap) ?? 0) === epoch
      if (claim && current) this.landed = new Set([...this.landed, cap])
      if (claim && !current) {
        this.deps.logger.info(
          'composed claim landed with a field set a withhold has since changed — the next write claims again',
          { tags: { deviceId: this.deps.deviceId }, meta: { cap, owner: this.deps.owner, fields } },
        )
      }
      this.logLanded(cap, op, claim, fields)
      return
    }
    if (CLAIM_LOST_CODES.has(outcome.code))
      this.landed = new Set([...this.landed].filter((c) => c !== cap))
    // Only `not-claimed` says the hub holds nothing; `field-not-claimed` means a claim EXISTS (N-3).
    if (outcome.code === 'not-claimed') this.report(cap, 'free')
    else if (claim) this.report(cap, 'unsettled')
    this.fail(cap, { kind: 'refused', code: outcome.code, message: outcome.message })
  }

  private async sendRelease(cap: string): Promise<void> {
    const extras = {
      tags: { deviceId: this.deps.deviceId },
      meta: { cap, owner: this.deps.owner },
    }
    let outcome: ClaimOutcome
    try {
      outcome = await this.deps.api.releaseClaim({
        deviceId: this.deps.deviceId,
        capName: cap,
        owner: this.deps.owner,
      })
    } catch (err: unknown) {
      this.fail(cap, { kind: 'threw', error: errMsg(err) })
      return
    }
    if (outcome.ok) {
      this.report(cap, 'free')
      this.deps.logger.info(
        'composed claim released — every field of the capability is handed back to the native provider',
        extras,
      )
      return
    }
    if (outcome.code === 'not-claimed') {
      this.report(cap, 'free')
      this.deps.logger.debug('composed claim release found nothing to hand back', extras)
      return
    }
    this.fail(cap, { kind: 'refused', code: outcome.code, message: outcome.message })
  }

  private logLanded(
    cap: string,
    op: PendingWrite,
    claim: boolean,
    fields: readonly string[],
  ): void {
    const tags = { deviceId: this.deps.deviceId }
    if (op.merged > 0) {
      this.deps.logger.info('composed write landed after absorbing merged patches', {
        tags,
        meta: { cap, owner: this.deps.owner, op: op.op, claim, merged: op.merged },
      })
    }
    if (claim) {
      this.deps.logger.info('composed claim landed', {
        tags,
        meta: { cap, owner: this.deps.owner, mode: this.deps.modeOf(cap), fields },
      })
    }
  }

  /** Only a `replace` cap has a native the tracker must tell apart from the merge (N-7). */
  private report(cap: string, event: ClaimEvent): void {
    if (this.deps.modeOf(cap) === 'replace') this.deps.onClaim?.(cap, event)
  }

  /** Escalated to the runtime; a failure nobody listens to is logged — never silent (D391). */
  private fail(cap: string, failure: TargetAsyncFailure): void {
    if (this.listeners.length === 0) {
      this.deps.logger.warn('composed write did not land and no runtime listens for it', {
        tags: { deviceId: this.deps.deviceId },
        meta: {
          cap,
          owner: this.deps.owner,
          ...(failure.kind === 'threw'
            ? { error: failure.error }
            : { code: failure.code, error: failure.message }),
        },
      })
    }
    for (const listener of this.listeners) listener(cap, failure)
  }
}
