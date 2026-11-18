/**
 * Turns the identity index's link candidates into `identity-links` records
 * (D1063), and serves the operator's decisions on them.
 *
 * | Situation                                   | Result                                         |
 * | ------------------------------------------- | ---------------------------------------------- |
 * | `auto` candidate, no row                    | `linked` / `auto`, `identity-link.created`     |
 * | `proposal` candidate, no row                | `proposed`, no event                           |
 * | `proposed` row, candidate now `auto`        | `linked` / `auto`, created                     |
 * | `dismissed` row                             | stays dismissed: nothing re-proposes it        |
 * | `linked`/`auto` row, evidence gone          | row deleted, `identity-link.lost` evidence-gone |
 * | `linked`/`operator` row, evidence gone      | kept, flagged `evidenceGone`, `lost` evidence-gone |
 * | `linked`/`operator` flagged, evidence back  | flag cleared, `identity-link.created`          |
 * | `proposed` row, evidence gone               | row deleted, no event (it never linked)        |
 *
 * "Evidence gone" is judged from the PERSISTED identifiers, which already keep
 * an unread value (D49): a camera rebooting, a port that read no client this
 * poll, change nothing. A flagged operator link never acts: `power-source`
 * refuses through it and core-blocks withdraws its contribution, so a fresh link
 * on another port can contribute. It waits for the operator (Unlink) or for its
 * evidence to return. A link whose side has no row right now is left alone —
 * a removed device is the `identity-links` removal step's, never a guess here.
 *
 * Runs after the seed and on every identity change the index reports,
 * coalesced: a pass already queued absorbs the next request. No timer. Every
 * write — a pass, an operator decision, a removal — runs on one chain.
 */
import {
  EventCategory,
  errMsg,
  identityLinkId,
  identityLinkSidesRefusal,
  type IdentityLink,
  type IdentityLinkDecision,
  type IdentityLinkEventPayload,
  type IdentityLinkLostReason,
  type IdentityLinkSide,
  type IdentityLinksRead,
  type IdentityMatchedKey,
  type IScopedLogger,
} from '@camstack/types'
import type { IdentityLinkCandidate, IdentityLinkCandidates } from './device-identity-index.js'
import type { IdentityLinksStore } from './identity-links-store.js'

export interface IdentityLinkReconcilerDeps {
  readonly candidates: () => IdentityLinkCandidates
  readonly store: IdentityLinksStore
  readonly emit: (
    category: EventCategory.IdentityLinkCreated | EventCategory.IdentityLinkLost,
    payload: IdentityLinkEventPayload,
  ) => void
  readonly logger: IScopedLogger
  readonly now?: () => number
}

const NOT_LOADED = 'the identity links have not been read yet'

function sameEvidence(x: readonly IdentityMatchedKey[], y: readonly IdentityMatchedKey[]): boolean {
  return JSON.stringify(x) === JSON.stringify(y)
}

function sameSide(x: IdentityLinkSide, y: IdentityLinkSide): boolean {
  return x.deviceId === y.deviceId && x.addonId === y.addonId && x.stableId === y.stableId
}

export function payloadOf(
  link: IdentityLink,
  reason?: IdentityLinkLostReason,
): IdentityLinkEventPayload {
  return {
    linkId: link.id,
    kind: link.kind,
    aDeviceId: link.a.deviceId,
    bDeviceId: link.b.deviceId,
    origin: link.origin,
    ...(reason !== undefined ? { reason } : {}),
  }
}

export class IdentityLinkReconciler {
  private tail: Promise<unknown> = Promise.resolve()
  private passQueued = false
  private readonly now: () => number

  constructor(private readonly deps: IdentityLinkReconcilerDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  /** Queue one pass; a pass already queued (not started) absorbs this request. */
  requestPass(): void {
    if (this.passQueued) return
    this.passQueued = true
    void this.serialized(async () => {
      this.passQueued = false
      await this.pass()
    }).catch((err: unknown) => {
      this.deps.logger.warn('identity-link pass failed — the next identity change retries', {
        meta: { error: errMsg(err) },
      })
    })
  }

  /** Resolves when every queued write has run (tests, boot). */
  async settled(): Promise<void> {
    await this.serialized(async () => undefined)
  }

  list(deviceId?: number): IdentityLinksRead {
    const links = this.deps.store.list()
    if (links === null) return { status: 'not-loaded', reason: NOT_LOADED }
    const named =
      deviceId === undefined
        ? links
        : links.filter((l) => l.a.deviceId === deviceId || l.b.deviceId === deviceId)
    return { status: 'answered', links: [...named].sort((x, y) => x.id.localeCompare(y.id)) }
  }

  confirm(linkId: string): Promise<IdentityLinkDecision> {
    return this.decide(linkId, 'proposed', async (link) => {
      const next: IdentityLink = {
        ...link,
        state: 'linked',
        origin: 'operator',
        decidedAt: this.now(),
      }
      await this.deps.store.put(next)
      this.log('identity link confirmed by the operator', next)
      this.deps.emit(EventCategory.IdentityLinkCreated, payloadOf(next))
      return next
    })
  }

  dismiss(linkId: string): Promise<IdentityLinkDecision> {
    return this.decide(linkId, 'proposed', async (link) => {
      const next = this.dismissed(link)
      await this.deps.store.put(next)
      this.log('identity link proposal dismissed by the operator', next)
      return next
    })
  }

  unlink(linkId: string): Promise<IdentityLinkDecision> {
    return this.decide(linkId, 'linked', async (link) => {
      const next = this.dismissed(link)
      await this.deps.store.put(next)
      this.log('identity link unlinked by the operator', next)
      this.deps.emit(EventCategory.IdentityLinkLost, payloadOf(next, 'operator-unlinked'))
      return next
    })
  }

  /** The `identity-links` removal step (D864): every link naming the device goes. */
  removeDevice(deviceId: number): Promise<number> {
    return this.serialized(async () => {
      const links = this.deps.store.list()
      if (links === null) throw new Error(NOT_LOADED)
      let removed = 0
      for (const link of links) {
        if (link.a.deviceId !== deviceId && link.b.deviceId !== deviceId) continue
        await this.deps.store.delete(link.id)
        removed += 1
        if (link.state === 'linked') {
          this.log('identity link lost — a side was removed', link, deviceId)
          this.deps.emit(EventCategory.IdentityLinkLost, payloadOf(link, 'device-removed'))
        }
      }
      return removed
    })
  }

  /** One pass over every candidate and every stored link. */
  async pass(): Promise<void> {
    const answer = this.deps.candidates()
    const links = this.deps.store.list()
    if (answer.status !== 'answered' || links === null) return
    const byId = new Map(links.map((l) => [l.id, l]))
    const seen = new Set<string>()
    for (const candidate of answer.candidates) {
      const id = identityLinkId(candidate.kind, candidate.a, candidate.b)
      if (seen.has(id)) continue
      seen.add(id)
      await this.applyCandidate(id, candidate, byId.get(id) ?? null)
    }
    for (const link of links) {
      if (seen.has(link.id)) continue
      const aId = answer.deviceIdOf(link.a.addonId, link.a.stableId)
      const bId = answer.deviceIdOf(link.b.addonId, link.b.stableId)
      // A side with no row is a removal (or a re-registration in flight): not evidence.
      if (aId === null || bId === null) continue
      await this.applyEvidenceGone(link)
    }
  }

  private async applyCandidate(
    id: string,
    candidate: IdentityLinkCandidate,
    stored: IdentityLink | null,
  ): Promise<void> {
    if (identityLinkSidesRefusal(candidate.kind, candidate.aRole) !== null) {
      this.deps.logger.debug('identity candidate skipped — the attaching side has the wrong role', {
        tags: { deviceId: candidate.a.deviceId },
        meta: { kind: candidate.kind, role: candidate.aRole, other: candidate.b.deviceId },
      })
      return
    }
    if (stored === null) {
      const auto = candidate.confidence === 'auto'
      const link: IdentityLink = {
        id,
        kind: candidate.kind,
        a: candidate.a,
        b: candidate.b,
        state: auto ? 'linked' : 'proposed',
        origin: 'auto',
        evidence: candidate.keys,
        createdAt: this.now(),
        ...(auto ? { decidedAt: this.now() } : {}),
      }
      await this.deps.store.put(link)
      this.log(auto ? 'identity link created on strong evidence' : 'identity link proposed', link)
      if (auto) this.deps.emit(EventCategory.IdentityLinkCreated, payloadOf(link))
      return
    }
    if (stored.state === 'dismissed') return
    const upgrade = stored.state === 'proposed' && candidate.confidence === 'auto'
    const moved =
      !sameSide(stored.a, candidate.a) ||
      !sameSide(stored.b, candidate.b) ||
      !sameEvidence(stored.evidence, candidate.keys) ||
      stored.evidenceGone === true
    if (!upgrade && !moved) return
    const returned = stored.state === 'linked' && stored.evidenceGone === true
    const { evidenceGone: _dropped, ...rest } = stored
    const next: IdentityLink = {
      ...rest,
      a: candidate.a,
      b: candidate.b,
      evidence: candidate.keys,
      ...(upgrade ? { state: 'linked', origin: 'auto', decidedAt: this.now() } : {}),
    }
    await this.deps.store.put(next)
    if (upgrade) {
      this.log('identity link created — the proposal now has strong evidence', next)
      this.deps.emit(EventCategory.IdentityLinkCreated, payloadOf(next))
    }
    if (returned) {
      this.log('identity link acts again — the evidence of a confirmed link is back', next)
      this.deps.emit(EventCategory.IdentityLinkCreated, payloadOf(next))
    }
  }

  private async applyEvidenceGone(link: IdentityLink): Promise<void> {
    if (link.state === 'dismissed') return
    if (link.state === 'proposed') {
      await this.deps.store.delete(link.id)
      this.log('identity link proposal withdrawn — its evidence is gone', link)
      return
    }
    if (link.origin === 'operator') {
      if (link.evidenceGone === true) return
      await this.deps.store.put({ ...link, evidenceGone: true })
      this.warn(
        'identity link no longer acts — confirmed by the operator, but its evidence is gone; Unlink it, or it acts again when the evidence returns',
        link,
      )
      this.deps.emit(EventCategory.IdentityLinkLost, payloadOf(link, 'evidence-gone'))
      return
    }
    await this.deps.store.delete(link.id)
    this.log('identity link lost — its evidence is gone', link)
    this.deps.emit(EventCategory.IdentityLinkLost, payloadOf(link, 'evidence-gone'))
  }

  private dismissed(link: IdentityLink): IdentityLink {
    return { ...link, state: 'dismissed', origin: 'operator', decidedAt: this.now() }
  }

  private decide(
    linkId: string,
    from: IdentityLink['state'],
    apply: (link: IdentityLink) => Promise<IdentityLink>,
  ): Promise<IdentityLinkDecision> {
    return this.serialized(async (): Promise<IdentityLinkDecision> => {
      if (!this.deps.store.isLoaded()) {
        return { ok: false, reason: 'not-loaded', message: NOT_LOADED }
      }
      const link = this.deps.store.get(linkId)
      if (link === null) {
        return { ok: false, reason: 'unknown-link', message: `no identity link ${linkId}` }
      }
      if (link.state !== from) {
        return {
          ok: false,
          reason: 'wrong-state',
          message: `identity link ${linkId} is ${link.state}, not ${from}`,
        }
      }
      return { ok: true, link: await apply(link) }
    })
  }

  /** One line per side, so each camera's log carries it (`tags.deviceId`). */
  private log(message: string, link: IdentityLink, only?: number): void {
    this.lines('info', message, link, only)
  }

  private warn(message: string, link: IdentityLink): void {
    this.lines('warn', message, link)
  }

  private lines(level: 'info' | 'warn', message: string, link: IdentityLink, only?: number): void {
    for (const side of [link.a, link.b]) {
      if (only !== undefined && side.deviceId === only) continue
      this.deps.logger[level](message, {
        tags: { deviceId: side.deviceId },
        meta: {
          linkId: link.id,
          kind: link.kind,
          state: link.state,
          origin: link.origin,
          other: side === link.a ? link.b.deviceId : link.a.deviceId,
          evidence: link.evidence.map((k) => k.key),
        },
      })
    }
  }

  private serialized<T>(write: () => Promise<T>): Promise<T> {
    const run = this.tail.then(write, write)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
