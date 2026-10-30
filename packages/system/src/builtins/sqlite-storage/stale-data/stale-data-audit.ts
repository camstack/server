/**
 * The stale-data audit (D905): finds data an addon left behind and no longer
 * uses, and lets an operator remove it.
 *
 * DETECTION IS READ-ONLY. A scan reads the addon list, the record catalog and
 * the stored settings keys, asks each running addon (in its own process) which
 * keys it still declares, and keeps the verdicts in memory. Nothing is deleted
 * by a scan; the only write is the `orphaned` flag on a record kind.
 *
 * DELETION is a separate, operator-triggered call that re-checks the verdict at
 * call time and refuses anything not still orphaned / stale.
 *
 * Three verdicts, never blurred (D315): `orphaned`/`stale` is proof; `unknown`
 * is an owner that could not be judged and is never touched.
 *
 * Every finding is logged once per scan with owner and key/kind - never values.
 */
import {
  collectSecretMarkerRefs,
  type IScopedLogger,
  type StaleDataReport,
  type StaleKindFinding,
  type StaleSettingsKeyFinding,
  type StorageKind,
} from '@camstack/types'
import type { DropKindResult, KindRef } from '../records/records-engine-types.js'

/** Owners whose kinds the audit never drops (local-auth's legacy tables go by hand, D902). */
export const PROTECTED_KIND_OWNERS: readonly string[] = ['local-auth']

export type ScanTrigger = 'boot' | 'interval' | 'manual'

/** One installed addon, as the addon list reports it. */
export interface AddonPresence {
  readonly id: string
  readonly running: boolean
}

export interface UnsetOutcome {
  readonly removed: readonly string[]
  readonly refused: readonly { readonly key: string; readonly reason: string }[]
  readonly secretsCleared: number
}

/** Everything the audit touches, injected so the verdicts can be proved without a hub. */
export interface StaleDataPorts {
  /** `null` when the list cannot be read: every owner is then `unknown`. */
  listAddons(): Promise<readonly AddonPresence[] | null>
  listKinds(): Promise<readonly StorageKind[]>
  markOrphaned(kinds: readonly KindRef[]): Promise<void>
  dropKind(ref: KindRef): Promise<DropKindResult>
  /** The raw stored global-settings map of an addon (markers, not values). */
  storedSettings(addonId: string): Promise<Readonly<Record<string, unknown>>>
  /** Ask the running addon; `null` when it did not answer. */
  declaredKeys(addonId: string): Promise<readonly string[] | null>
  unsetKeys(addonId: string, keys: readonly string[]): Promise<UnsetOutcome>
  releaseSecrets(refs: readonly string[], userId: string): Promise<number>
  readonly logger: IScopedLogger
  readonly now: () => number
}

export class StaleDataRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleDataRefusedError'
  }
}

const EMPTY_REPORT: StaleDataReport = {
  scannedAt: null,
  scanning: false,
  trigger: null,
  kinds: [],
  settingsKeys: [],
  unknown: [],
}

/** `<key>@<nodeId>` is a per-node copy of `<key>`. */
function baseKeyOf(key: string): string {
  const at = key.indexOf('@')
  return at > 0 ? key.slice(0, at) : key
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function kindKey(owner: string, kind: string): string {
  return `${owner}\u0000${kind}`
}

interface KindJudgement {
  readonly findings: readonly StaleKindFinding[]
  readonly orphaned: readonly KindRef[]
}

export class StaleDataAudit {
  private report: StaleDataReport = EMPTY_REPORT
  private inFlight: Promise<StaleDataReport> | null = null

  constructor(private readonly ports: StaleDataPorts) {}

  current(): StaleDataReport {
    return this.report
  }

  /** Scan now. A scan already running is joined, not doubled. */
  scan(trigger: ScanTrigger): Promise<StaleDataReport> {
    if (this.inFlight !== null) return this.inFlight
    this.report = { ...this.report, scanning: true }
    const run = this.runScan(trigger).finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private async runScan(trigger: ScanTrigger): Promise<StaleDataReport> {
    const unknown: { subject: string; reason: string }[] = []
    try {
      const addons = await this.ports.listAddons()
      const kinds = await this.judgeKinds(addons)
      if (kinds.orphaned.length > 0) await this.ports.markOrphaned(kinds.orphaned)
      const settingsKeys = await this.judgeSettings(addons, unknown)
      this.report = {
        scannedAt: this.ports.now(),
        scanning: false,
        trigger,
        kinds: [...kinds.findings],
        settingsKeys,
        unknown,
      }
      this.logFindings(trigger)
    } catch (err) {
      this.report = { ...this.report, scanning: false }
      this.ports.logger.warn('stale-data: scan failed', { meta: { trigger, error: errMsg(err) } })
    }
    return this.report
  }

  // ── record kinds ────────────────────────────────────────────────────────

  private async judgeKinds(addons: readonly AddonPresence[] | null): Promise<KindJudgement> {
    const kinds = (await this.ports.listKinds()).filter((k) => k.state !== 'dropped')
    const byOwner = new Map<string, boolean>()
    for (const a of addons ?? []) byOwner.set(a.id, a.running)
    const ownersDeclaring = new Set(kinds.filter((k) => k.declaredThisBoot).map((k) => k.owner))

    const findings: StaleKindFinding[] = []
    const orphaned: KindRef[] = []
    for (const k of kinds) {
      const verdict = this.kindVerdict(k, addons === null ? null : byOwner, ownersDeclaring)
      if (verdict === null) continue
      const isProtected = PROTECTED_KIND_OWNERS.includes(k.owner)
      findings.push({
        owner: k.owner,
        kind: k.kind,
        verdict: verdict.verdict,
        reason: verdict.reason,
        rows: k.rows,
        protected: isProtected,
      })
      if (verdict.verdict === 'orphaned' && !isProtected) {
        orphaned.push({ owner: k.owner, kind: k.kind })
      }
    }
    return { findings, orphaned }
  }

  /** `null` = in use, nothing to report. */
  private kindVerdict(
    k: StorageKind,
    owners: ReadonlyMap<string, boolean> | null,
    ownersDeclaring: ReadonlySet<string>,
  ): { verdict: 'orphaned' | 'unknown'; reason: string } | null {
    if (owners === null) {
      return { verdict: 'unknown', reason: 'the addon list could not be read' }
    }
    const running = owners.get(k.owner)
    if (running === undefined) {
      return { verdict: 'orphaned', reason: 'the owner package is not installed' }
    }
    if (!running) {
      return { verdict: 'unknown', reason: 'the owner is installed but not running' }
    }
    if (k.declaredThisBoot) return null
    if (!ownersDeclaring.has(k.owner)) {
      // A running owner that declared NOTHING since the engine started may simply
      // predate it (an agent runner outlives a hub restart): not proof.
      return {
        verdict: 'unknown',
        reason: 'the owner is running but declared no kind since the hub started',
      }
    }
    return {
      verdict: 'orphaned',
      reason: 'the running owner no longer declares this kind',
    }
  }

  // ── settings keys ───────────────────────────────────────────────────────

  private async judgeSettings(
    addons: readonly AddonPresence[] | null,
    unknown: { subject: string; reason: string }[],
  ): Promise<StaleSettingsKeyFinding[]> {
    const out: StaleSettingsKeyFinding[] = []
    if (addons === null) return out
    for (const addon of addons) {
      if (!addon.running) continue
      try {
        out.push(...(await this.staleKeysOf(addon.id, unknown)))
      } catch (err) {
        unknown.push({ subject: addon.id, reason: `audit failed: ${errMsg(err)}` })
      }
    }
    return out
  }

  private async staleKeysOf(
    addonId: string,
    unknown: { subject: string; reason: string }[],
  ): Promise<StaleSettingsKeyFinding[]> {
    const stored = await this.ports.storedSettings(addonId)
    const keys = Object.keys(stored)
    if (keys.length === 0) return []
    const declared = await this.ports.declaredKeys(addonId)
    if (declared === null) {
      unknown.push({ subject: addonId, reason: 'the addon did not answer which keys it declares' })
      return []
    }
    const declaredSet = new Set(declared)
    const staleKeys = keys.filter((key) => !declaredSet.has(baseKeyOf(key)))
    if (staleKeys.length === 0) return []

    const live = new Set<string>()
    for (const key of keys) {
      if (staleKeys.includes(key)) continue
      for (const ref of collectSecretMarkerRefs(stored[key])) live.add(ref)
    }
    return staleKeys.map((key) => ({
      addonId,
      key,
      secretRefs: [...new Set(collectSecretMarkerRefs(stored[key]))]
        .filter((ref) => !live.has(ref))
        .toSorted(),
    }))
  }

  // ── logging ─────────────────────────────────────────────────────────────

  /** One line per finding, owner and key/kind only - a value never reaches a log. */
  private logFindings(trigger: ScanTrigger): void {
    const { kinds, settingsKeys, unknown } = this.report
    for (const f of kinds) {
      this.ports.logger.info('stale-data: record kind', {
        meta: { trigger, owner: f.owner, kind: f.kind, verdict: f.verdict, reason: f.reason },
      })
    }
    for (const f of settingsKeys) {
      this.ports.logger.info('stale-data: settings key', {
        meta: { trigger, addonId: f.addonId, key: f.key, secretRefs: f.secretRefs.length },
      })
    }
    for (const u of unknown) {
      this.ports.logger.info('stale-data: not judged', {
        meta: { trigger, subject: u.subject, reason: u.reason },
      })
    }
    this.ports.logger.info('stale-data: scan finished', {
      meta: {
        trigger,
        orphanedKinds: kinds.filter((k) => k.verdict === 'orphaned').length,
        unknownKinds: kinds.filter((k) => k.verdict === 'unknown').length,
        staleKeys: settingsKeys.length,
        notJudged: unknown.length,
      },
    })
  }

  // ── operator deletion ───────────────────────────────────────────────────

  /** Drop an orphaned kind: its rows, their keychain values, then mark it dropped. */
  async dropOrphanedKind(
    target: KindRef,
    userId: string,
  ): Promise<{ deleted: number; secretsReleased: number }> {
    if (PROTECTED_KIND_OWNERS.includes(target.owner)) {
      throw new StaleDataRefusedError(`"${target.owner}" kinds are never dropped by the audit`)
    }
    // The verdict is recomputed NOW: a scan from hours ago proves nothing.
    const addons = await this.ports.listAddons()
    const fresh = await this.judgeKinds(addons)
    const stillOrphaned = fresh.orphaned.some(
      (k) => kindKey(k.owner, k.kind) === kindKey(target.owner, target.kind),
    )
    if (!stillOrphaned) {
      throw new StaleDataRefusedError(
        `"${target.owner}" kind "${target.kind}" is not orphaned any more - nothing was dropped`,
      )
    }
    await this.ports.markOrphaned([target])
    const result = await this.ports.dropKind(target)
    const secretsReleased =
      result.secretRefs.length > 0 ? await this.ports.releaseSecrets(result.secretRefs, userId) : 0
    this.ports.logger.warn('stale-data: record kind dropped', {
      meta: {
        owner: target.owner,
        kind: target.kind,
        deleted: result.deleted,
        secretsReleased,
        operator: userId,
      },
    })
    this.report = {
      ...this.report,
      kinds: this.report.kinds.filter(
        (k) => kindKey(k.owner, k.kind) !== kindKey(target.owner, target.kind),
      ),
    }
    return { deleted: result.deleted, secretsReleased }
  }

  /** Unset one stale settings key on a running addon, with the keychain values it held. */
  async unsetStaleSettingsKey(
    addonId: string,
    key: string,
    userId: string,
  ): Promise<{ removed: boolean; secretsCleared: number }> {
    const addons = await this.ports.listAddons()
    const running = addons?.find((a) => a.id === addonId)?.running === true
    if (!running) {
      throw new StaleDataRefusedError(`"${addonId}" is not running - its keys cannot be judged`)
    }
    const unknown: { subject: string; reason: string }[] = []
    const stale = await this.staleKeysOf(addonId, unknown)
    if (!stale.some((s) => s.key === key)) {
      throw new StaleDataRefusedError(
        `"${addonId}" key "${key}" is not stale any more - nothing was removed`,
      )
    }
    const outcome = await this.ports.unsetKeys(addonId, [key])
    const removed = outcome.removed.includes(key)
    this.ports.logger.warn('stale-data: settings key unset', {
      meta: { addonId, key, removed, secretsCleared: outcome.secretsCleared, operator: userId },
    })
    if (removed) {
      this.report = {
        ...this.report,
        settingsKeys: this.report.settingsKeys.filter(
          (s) => !(s.addonId === addonId && s.key === key),
        ),
      }
    }
    return { removed, secretsCleared: outcome.secretsCleared }
  }
}
