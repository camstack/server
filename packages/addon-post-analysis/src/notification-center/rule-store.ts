/**
 * NcRuleStore — durable Notification Center rule set.
 *
 * Records migration (phase 2, step 24): uses `RecordKindHandle<RuleBody>`
 * over the `notification-center/rules` record kind instead of the legacy
 * `DurableLedger`. Owner stamp: `pipeline-analytics` (the hosting addon).
 *
 * ## What this store keeps from the DurableLedger era
 *
 * - In-memory mirror + write-through: a failed persist never leaves a phantom in-RAM rule.
 * - A failed `load()` NEVER clears the mirror (D130): "a cleared mirror means no rules and
 *   no notifications" is a worse failure direction than "stale rules still firing".
 * - `isLoaded()` distinguishes "store down on boot" from "hub has no rules" for every
 *   consumer that derives something destructive from an empty set (clip-retention plan,
 *   deleted-device prune, consumable threshold census).
 * - The identity-name migration (D692) still runs as a READ-ONLY pass over the mirror —
 *   mirror-only, no write back, a gallery that fails to load must never be able to rewrite
 *   a stored rule into one that matches nobody.
 * - The retired-field projection (D692 §9): `projectRawStoredRule` is called on the raw
 *   `row.data` at load time to merge `waitForEnhancement`/`groupIdleSec` → `groupingSec`
 *   into the parsed rule. The stored body is never altered; every write through this store
 *   serialises the typed rule (no retired keys), so the first explicit mutation strips them.
 * - `stripRetiredKeys` (for an explicit `clear: ['waitForEnhancement']`): since any `put()`
 *   serialises through `RuleBodySchema` (unknown keys stripped by Zod), writing the current
 *   mirror rule back is the strip. The projected `groupingSec` is preserved as an explicit
 *   field.
 *
 * ## Cross-node note
 *
 * The `rules` record kind lives in the hub's centralized settings-store, so a CRUD served on
 * one node is visible to the evaluating (post-processing) node after its periodic `load()`
 * refresh — bounded staleness, never wrongness (D8 reconcile-over-events).
 */

import { randomUUID } from 'node:crypto'
import type {
  IScopedLogger,
  NcRule,
  NcRuleClearableKey,
  NcRuleInput,
  NcRulePatch,
  RecordKindHandle,
  RecordsAccess,
} from '@camstack/types'
import {
  isRetiredClearKey,
  NcRuleSchema,
  normalizeNcMediaPolicy,
  withSystemEventClasses,
} from '@camstack/types'
import { warnLegacyAudioClassRules } from './detection-audio-guard.js'
import { type NcRereadResult, rereadRecordRow } from './durable-reread.js'
import {
  type NcGroupingRepair,
  type NcRetiredFieldProjection,
  projectRawStoredRule,
  stripStoredKeys,
} from './rule-retired-fields.js'
import { ncRecordKinds, type RuleBody } from './record-kinds.js'

/**
 * @durable class=config owner=pipeline-analytics
 *   write="an operator creates, edits, enables/disables a rule or opts a target out of it; nothing writes on the evaluation path"
 *   retention="none — a row goes only when the operator deletes the rule. Bounded by the rule set a human is willing to author."
 */
export const NC_RULES_COLLECTION = 'notification-center:rules'

/** Query cap — the rule set is operator-authored and tiny; a generous ceiling. */
const LOAD_LIMIT = 10_000

/** A projection `fromRecord` made, handed to whoever can log it (`fromRecord` has no logger). */
type NcProjectedRule = Extract<NcRetiredFieldProjection, { readonly kind: 'projected' }>
type NcProjectionSink = (ruleId: string, projection: NcProjectedRule) => void
type NcRepairedGrouping = Extract<NcGroupingRepair, { readonly kind: 'repaired' }>
type NcGroupingRepairSink = (ruleId: string, repair: NcRepairedGrouping) => void
type NcClassWideningSink = (ruleId: string, before: NcRule, after: NcRule) => void
type NcRetiredClearKey = Extract<NcRuleClearableKey, 'waitForEnhancement' | 'groupIdleSec'>
type NcStoredClearKey = Exclude<NcRuleClearableKey, NcRetiredClearKey>

/**
 * Parse a raw body object (as returned from storage — may contain retired keys)
 * into an `NcRule` applying the legacy field projection.
 */
function bodyToRule(
  id: string,
  raw: RuleBody,
  onProjection?: NcProjectionSink,
  onGroupingRepair?: NcGroupingRepairSink,
): NcRule | null {
  const parsed = parseStoredRule(id, raw, onProjection, onGroupingRepair)
  return parsed.ok ? parsed.rule : null
}

/** A stored row parsed, or the first reason it could not be — so a skip can be NAMED. */
type NcStoredRuleParse =
  | { readonly ok: true; readonly rule: NcRule }
  | { readonly ok: false; readonly reason: string }

function parseStoredRule(
  id: string,
  raw: RuleBody,
  onProjection?: NcProjectionSink,
  onGroupingRepair?: NcGroupingRepairSink,
  onClassWidening?: NcClassWideningSink,
): NcStoredRuleParse {
  const { candidate, projection, groupingRepair } = projectRawStoredRule(raw)
  const parsed = NcRuleSchema.safeParse({ ...(candidate as object), id })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const reason =
      issue === undefined ? 'invalid' : `${issue.path.join('.') || '(root)'}: ${issue.message}`
    return { ok: false, reason }
  }
  if (projection.kind === 'projected') onProjection?.(id, projection)
  if (groupingRepair.kind === 'repaired') onGroupingRepair?.(id, groupingRepair)
  const media = withNormalizedMedia(parsed.data)
  const rule = withSystemEventClasses(media)
  if (rule !== media) onClassWidening?.(id, media, rule)
  return { ok: true, rule }
}

/**
 * D906: what a rule is stored as — its media policy folded (D897) and, on an
 * INSTANT system rule, every paired class it touches completed with both
 * edges. Applied on every WRITE; the load applies the same through
 * {@link parseStoredRule}, which also says once that it widened a rule.
 */
function normalizeStoredRule(rule: NcRule): NcRule {
  return withSystemEventClasses(withNormalizedMedia(rule))
}

/** A stored row the load could not parse: which rule, and the first reason. */
export interface NcSkippedRuleRow {
  readonly ruleId: string
  readonly name: string | null
  readonly reason: string
}

/** At most this many skipped rows are NAMED in the WARN line; the count is always whole. */
const SKIPPED_ROWS_NAMED_MAX = 10

/**
 * D897: the rule with its media policy in the stored shape — `image` set, the
 * legacy `attach` / `frame` / `zoneCrop` folded into it. Applied on LOAD (a read
 * projection: a rule nobody saved since keeps its row as written) and on every
 * WRITE, so the first save of a rule converges its row and an editor that still
 * sends the legacy triple is folded on the way in.
 */
function withNormalizedMedia(rule: NcRule): NcRule {
  return { ...rule, media: normalizeNcMediaPolicy(rule.media, rule) }
}

export interface NcRuleStoreRecordsDeps {
  readonly kind: RecordKindHandle<RuleBody>
  readonly logger: IScopedLogger
  readonly now?: () => number
  readonly newId?: () => string
  readonly identityIdsByName?: () => Promise<ReadonlyMap<string, string>>
}

export type NcRuleStoreDeps = NcRuleStoreRecordsDeps

/**
 * Resolve display names to gallery ids inside one rule's identity conditions.
 *
 * NON-DESTRUCTIVE and IDEMPOTENT, in that order of importance:
 *
 *  - a value the map answers for becomes the id;
 *  - a value it does not answer for is LEFT AS IT STANDS, not dropped. It is
 *    either already an id (the second load of a migrated rule, and every load
 *    after that), or a name the gallery no longer holds — and a rule whose
 *    scope silently shrank is exactly the failure this repo keeps paying for.
 *    The engine's name leg keeps such a value matching what it always matched;
 *    the caller reports it once.
 *  - nothing is written back. The migration is a READ projection, so a gallery
 *    that failed to load, or loaded empty, cannot rewrite a rule into one that
 *    matches nobody. The stored rule keeps the operator's words forever.
 *
 * Returns the rule unchanged (by identity) when nothing resolved, so `load`
 * can tell a migrated rule from an untouched one without comparing.
 */
export function migrateIdentityNames(
  rule: NcRule,
  idsByName: ReadonlyMap<string, string>,
): { readonly rule: NcRule; readonly unresolved: readonly string[] } {
  const identities = rule.conditions.identities
  const excluded = rule.conditions.identitiesExclude
  if (identities === undefined && excluded === undefined) return { rule, unresolved: [] }
  const unresolved: string[] = []
  const known = new Set(idsByName.values())
  const resolve = (values: readonly string[]): string[] =>
    values.map((value) => {
      if (known.has(value)) return value
      const id = idsByName.get(value.trim().toLowerCase())
      if (id !== undefined) return id
      unresolved.push(value)
      return value
    })
  const nextIdentities = identities !== undefined ? resolve(identities) : undefined
  const nextExcluded = excluded !== undefined ? resolve(excluded) : undefined
  const changed =
    (nextIdentities !== undefined && !sameList(identities ?? [], nextIdentities)) ||
    (nextExcluded !== undefined && !sameList(excluded ?? [], nextExcluded))
  if (!changed) return { rule, unresolved }
  return {
    rule: {
      ...rule,
      conditions: {
        ...rule.conditions,
        ...(nextIdentities !== undefined ? { identities: nextIdentities } : {}),
        ...(nextExcluded !== undefined ? { identitiesExclude: nextExcluded } : {}),
      },
    },
    unresolved,
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export class NcRuleStore {
  private readonly byId = new Map<string, NcRule>()
  private readonly kind: RecordKindHandle<RuleBody>
  private readonly logger: IScopedLogger
  private readonly now: () => number
  private readonly newId: () => string
  private readonly identityIdsByName?: () => Promise<ReadonlyMap<string, string>>
  /** Rows the last successful {@link load} skipped; `null` before one succeeded. */
  private skipped: readonly NcSkippedRuleRow[] | null = null
  /** Has a {@link load} ever completed? See the note there. */
  private loaded = false
  /** Legacy detection rules naming sounds already reported (D690) — once each. */
  private readonly audioClassWarned = new Set<string>()
  /**
   * Projections made since the last {@link load} drained them, latest per rule.
   * Bounded by the rule set: it is keyed by rule id and emptied on every load.
   */
  private readonly pendingProjections = new Map<string, NcProjectedRule>()
  /** Rules whose projection was already logged in this process (D692 §9) — once each. */
  private readonly projectionLogged = new Set<string>()
  /** Rules whose out-of-range `groupingSec` repair was already logged — once each. */
  private readonly groupingRepairLogged = new Set<string>()
  /** Rules whose class widening (D906) was already logged — once each. */
  private readonly classWideningLogged = new Set<string>()

  constructor(deps: NcRuleStoreDeps) {
    this.logger = deps.logger
    this.now = deps.now ?? ((): number => Date.now())
    this.newId = deps.newId ?? ((): string => randomUUID())
    if (deps.identityIdsByName !== undefined) this.identityIdsByName = deps.identityIdsByName
    this.kind = deps.kind
  }

  static of(
    records: Pick<RecordsAccess, 'kind'>,
    logger: IScopedLogger,
    now?: () => number,
    newId?: () => string,
    identityIdsByName?: () => Promise<ReadonlyMap<string, string>>,
  ): NcRuleStore {
    return new NcRuleStore({
      kind: records.kind(ncRecordKinds['rules']),
      logger,
      now,
      newId,
      identityIdsByName,
    })
  }

  /**
   * (Re)hydrate the FULL rule set from the store — called at boot and on the
   * periodic refresh tick (cross-node CRUD staleness bound).
   *
   * A row whose JSON no longer validates is skipped and counted at WARN.
   * **A failed read keeps the rule set already in memory** — a cleared mirror
   * means no rules and no notifications, which is worse than stale rules.
   *
   * The retired-field projection is applied per-row by `bodyToRule`; the
   * identity migration runs as a separate pass over the mirror.
   *
   * The identity migration runs as a pass over the rows returned:
   * mirror-only, no write. See {@link migrateIdentityIds}.
   */
  async load(): Promise<void> {
    try {
      const { records } = await this.kind.query({ limit: LOAD_LIMIT })
      const next = new Map<string, NcRule>()
      const skippedRows: NcSkippedRuleRow[] = []
      for (const row of records) {
        const parsed = parseStoredRule(
          row.id,
          row.data,
          (ruleId, projection) => {
            this.pendingProjections.set(ruleId, projection)
          },
          (ruleId, repair) => this.logGroupingRepair(ruleId, repair),
          (ruleId, before, after) => this.logClassWidening(ruleId, before, after),
        )
        if (!parsed.ok) {
          const name = row.data['name']
          skippedRows.push({
            ruleId: row.id,
            name: typeof name === 'string' ? name : null,
            reason: parsed.reason,
          })
          continue
        }
        next.set(row.id, parsed.rule)
      }
      this.byId.clear()
      for (const [id, rule] of next) this.byId.set(id, rule)
      this.skipped = skippedRows
      if (skippedRows.length > 0) {
        // A skipped row is a rule that silently stops notifying: name it and say why.
        this.logger.warn('notification rule rows skipped as malformed', {
          meta: {
            skipped: skippedRows.length,
            rows: skippedRows.slice(0, SKIPPED_ROWS_NAMED_MAX),
          },
        })
      }
      this.loaded = true
    } catch (err) {
      this.logger.warn('notification rules load failed — keeping rules already in memory', {
        meta: { error: String(err), rules: this.byId.size },
      })
    }
    this.logPendingProjections()
    // A detection rule stored naming a sound (before D690) is KEPT — it loads
    // and fires as it always did — and reported once, with its id.
    for (const id of warnLegacyAudioClassRules(
      [...this.byId.values()],
      this.audioClassWarned,
      this.logger,
    )) {
      this.audioClassWarned.add(id)
    }
    this.logger.debug('notification rules loaded', { meta: { rules: this.byId.size } })
  }

  /** Say, once per process per rule, that an instant rule was read as its whole class (D906). */
  private logClassWidening(ruleId: string, before: NcRule, after: NcRule): void {
    if (this.classWideningLogged.has(ruleId)) return
    this.classWideningLogged.add(ruleId)
    const had = new Set(before.conditions.systemEvent?.kinds ?? [])
    this.logger.info('instant system rule read as its whole event class — both edges', {
      meta: {
        ruleId,
        rule: after.name,
        added: (after.conditions.systemEvent?.kinds ?? []).filter((kind) => !had.has(kind)),
      },
    })
  }

  /** Say, once per process per rule, that an out-of-range stored `groupingSec` was repaired. */
  private logGroupingRepair(ruleId: string, repair: NcRepairedGrouping): void {
    if (this.groupingRepairLogged.has(ruleId)) return
    this.groupingRepairLogged.add(ruleId)
    this.logger.warn('rule carries an out-of-range groupingSec — repaired on read', {
      meta: { ruleId, from: repair.from, to: repair.to },
    })
  }

  /** Log, once per process per rule, what `bodyToRule` projected from a retired field. */
  private logPendingProjections(): void {
    for (const [ruleId, projection] of this.pendingProjections) {
      if (this.projectionLogged.has(ruleId)) continue
      this.projectionLogged.add(ruleId)
      this.logger.info('rule carries a retired delivery field — projected', {
        meta: {
          ruleId,
          from: projection.from,
          dropped: projection.dropped,
          ...(projection.groupingSec !== undefined ? { groupingSec: projection.groupingSec } : {}),
        },
      })
    }
    this.pendingProjections.clear()
  }

  /**
   * The identity NAME→ID migration, split out of {@link load} on 2026-08-19:
   * `readIdentityIds` reaches the identity gallery, and at boot that single
   * read cost 119 s — 74 s more than every other start() read combined —
   * while buying only an ENRICHMENT: the engine still matches by name (it
   * keeps that leg precisely for the gallery-cannot-answer case below). It
   * now runs as a back-fill phase; the rename-immunity ids arrive seconds
   * later instead of gating the intake.
   */
  async migrateIdentityIds(): Promise<void> {
    const rules = [...this.byId.values()]
    const idsByName = await this.readIdentityIds()
    let migrated = 0
    const unresolved = new Set<string>()
    for (const rule of rules) {
      const result = migrateIdentityNames(rule, idsByName)
      for (const name of result.unresolved) unresolved.add(name)
      if (result.rule === rule) continue
      migrated += 1
      this.byId.set(rule.id, result.rule)
    }
    if (migrated > 0) {
      this.logger.info('notification rules migrated identity names to ids', {
        meta: { identitiesResolvedToIds: migrated },
      })
    }
    if (unresolved.size > 0) {
      this.logger.info('notification rules name identities the gallery does not know', {
        meta: { names: [...unresolved].join(', ') },
      })
    }
  }

  /**
   * The name→id map, lower-cased, or EMPTY when there is none to be had.
   *
   * Empty is the safe answer and the only one: `migrateIdentityNames` resolves
   * nothing from an empty map and leaves every rule as the operator wrote it.
   * A gallery read that throws must never be able to change what a rule matches.
   */
  private async readIdentityIds(): Promise<ReadonlyMap<string, string>> {
    if (this.identityIdsByName === undefined) return new Map()
    try {
      return await this.identityIdsByName()
    } catch (err) {
      this.logger.debug('identity gallery read failed — rules left unmigrated', {
        meta: { error: String(err) },
      })
      return new Map()
    }
  }

  list(): readonly NcRule[] {
    return [...this.byId.values()].toSorted((a, b) => b.updatedAt - a.updatedAt)
  }

  listEnabled(delivery: NcRule['delivery']): readonly NcRule[] {
    return this.list().filter((r) => r.enabled && r.delivery === delivery)
  }

  /**
   * Whether the rule set in memory is an ANSWER about this hub.
   *
   * False until the first successful load. A consumer that derives something
   * DESTRUCTIVE from an empty rule set (the clip-retention plan drops a
   * camera's ring) must ask this first: before the first load the empty list
   * is not a fact, and a failed load leaves whatever was already mirrored.
   */
  /**
   * The rows the last SUCCESSFUL load could not parse — `null` until one has
   * succeeded, so "not read yet" never reads as "nothing broken" (D315).
   */
  skippedRows(): readonly NcSkippedRuleRow[] | null {
    return this.skipped
  }

  isLoaded(): boolean {
    return this.loaded
  }

  get(ruleId: string): NcRule | null {
    return this.byId.get(ruleId) ?? null
  }

  /**
   * Re-read ONE rule from the durable store into the mirror, for a writer
   * that must not act on a mirror a reload tick stale (the deleted-device
   * prune). Throws on a failed read; see `durable-reread.ts`.
   */
  reread(ruleId: string): Promise<NcRereadResult<NcRule>> {
    return rereadRecordRow(this.kind, this.byId, ruleId, (id, data) => bodyToRule(id, data))
  }

  /**
   * Rules visible to `userId`: their OWN personal rules (`ownerUserId ===
   * userId`) plus every admin/global rule (`ownerUserId` absent). Never
   * another user's personal rows. Newest-first (inherits {@link list}).
   *
   * The caller identity is server-derived; an absent/undefined caller must be
   * resolved to a fail-closed value by the bridge action BEFORE calling here —
   * this store never treats a missing caller as admin/global.
   */
  listForOwner(userId: string): readonly NcRule[] {
    return this.list().filter((r) => r.ownerUserId === undefined || r.ownerUserId === userId)
  }

  /** Create a new rule. `createdBy` is the SERVER-injected caller userId. */
  async create(input: NcRuleInput, createdBy: string): Promise<NcRule> {
    const now = this.now()
    const rule: NcRule = normalizeStoredRule({
      ...input,
      id: this.newId(),
      createdBy,
      createdAt: now,
      updatedAt: now,
      disabledTargetIds: [],
    })
    await this.write(rule)
    return rule
  }

  /**
   * Apply a partial patch. Immutable: returns the NEW rule object.
   *
   * `clear` names optional fields to REMOVE before the merge — an omitted key
   * keeps its stored value, so this is how an editor empties one. Setting and
   * clearing the same key is a contradiction and is refused rather than
   * resolved by ordering.
   *
   * A RETIRED key (D692 §2.3) cannot take the typed-patch path: it is stripped
   * by writing the current mirror rule back (which serialises through
   * `RuleBodySchema`, omitting retired keys), and then the remaining typed patch
   * is applied. A clear naming only retired keys, with nothing to patch, stops there.
   */
  async update(
    ruleId: string,
    patch: NcRulePatch,
    clear: readonly NcRuleClearableKey[] = [],
  ): Promise<NcRule> {
    const existing = this.byId.get(ruleId)
    if (!existing) throw new Error(`notification rule not found: ${ruleId}`)
    const retired: NcRetiredClearKey[] = []
    const stored: NcStoredClearKey[] = []
    for (const key of clear) {
      if (isRetiredClearKey(key)) retired.push(key)
      else stored.push(key)
    }
    const conflict = stored.find((key) => patch[key] !== undefined)
    if (conflict !== undefined) {
      throw new Error(`notification rule patch both sets and clears '${conflict}'`)
    }
    const base =
      retired.length > 0 ? await this.stripRetiredKeys(ruleId, retired, existing) : existing
    const patchIsEmpty = Object.values(patch).every((value) => value === undefined)
    if (retired.length > 0 && stored.length === 0 && patchIsEmpty) return base
    const cleared = new Set<string>(stored)
    const kept = Object.fromEntries(Object.entries(base).filter(([key]) => !cleared.has(key)))
    const candidate = {
      ...kept,
      ...patch,
      id: existing.id,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    }
    // Re-validate the merged object so a patch can never persist a rule
    // that would be skipped at the next load.
    const updated = normalizeStoredRule(NcRuleSchema.parse(candidate))
    await this.write(updated)
    return updated
  }

  /**
   * Strip named retired keys from the STORED row (D692 §2.3).
   *
   * `put` the typed body (Zod already omits unknown keys); drop `groupingSec`
   * from the mirror when no remaining retired source would project it.
   *
   * A clear that names only keys absent from the stored row is a no-op (no write).
   * A failed write THROWS.
   */
  private async stripRetiredKeys(
    ruleId: string,
    keys: readonly NcRetiredClearKey[],
    existing: NcRule,
  ): Promise<NcRule> {
    this.logger.debug('stripping retired keys from rule', {
      meta: { ruleId, keys },
    })
    try {
      return await this.stripRetiredKeysRecords(ruleId, keys, existing)
    } catch (err) {
      this.logger.warn('failed to strip retired key(s) from rule', {
        meta: { ruleId, keys, error: String(err) },
      })
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  private async stripRetiredKeysRecords(
    ruleId: string,
    keys: readonly NcRetiredClearKey[],
    existing: NcRule,
  ): Promise<NcRule> {
    const row = await this.kind.get(ruleId)
    if (row === null) return existing
    // The named keys live on the RAW row: the typed parse strips them, so asking the
    // parse found nothing to clear and the row kept the key it was told to lose.
    const remaining = stripStoredKeys(row.data, keys)
    if (remaining === null) return existing
    // What the row means WITHOUT those keys: a retired key left behind (the other one)
    // still carries its window, a cleared one no longer does. Reading the leftovers off
    // the typed mirror kept the cleared key's window, or dropped the other key's.
    const { candidate } = projectRawStoredRule(remaining)
    const parsed = NcRuleSchema.safeParse(
      typeof candidate === 'object' && candidate !== null
        ? { ...candidate, id: ruleId }
        : candidate,
    )
    if (!parsed.success) return existing
    const next = normalizeStoredRule(parsed.data)
    // A records body cannot hold a retired key (the kind's schema strips it on write), so
    // the window the remaining key carries is stored as the explicit `groupingSec`.
    const { id: _omit, ...data } = next
    await this.kind.put({ id: ruleId, data })
    this.byId.set(ruleId, next)
    return next
  }

  async setEnabled(ruleId: string, enabled: boolean): Promise<NcRule> {
    return this.update(ruleId, { enabled })
  }

  /**
   * Per-target opt-out toggle for a rule. `enabled: false` suppresses the
   * target for THIS rule at send time; `true` re-enables it. Idempotent per
   * target (a `Set` dedups; removing an absent id is a no-op). Throws when the
   * rule id is unknown.
   *
   * OWNERSHIP: this store applies the toggle unconditionally — the owner-only
   * restriction ("only a target's owner may opt it out") is enforced by the
   * `nc.setRuleTargetEnabled` bridge action, which resolves the fail-closed
   * caller and validates target ownership before calling here.
   */
  async setRuleTargetEnabled(ruleId: string, targetId: string, enabled: boolean): Promise<NcRule> {
    const existing = this.byId.get(ruleId)
    if (!existing) throw new Error(`notification rule not found: ${ruleId}`)
    const next = new Set(existing.disabledTargetIds)
    if (enabled) next.delete(targetId)
    else next.add(targetId)
    return this.update(ruleId, { disabledTargetIds: [...next] })
  }

  /** Hot-path read for the dispatcher: is `targetId` opted out of `ruleId`? */
  isRuleTargetDisabled(ruleId: string, targetId: string): boolean {
    const rule = this.byId.get(ruleId)
    return rule ? rule.disabledTargetIds.includes(targetId) : false
  }

  /**
   * Idempotent delete — unknown ids are a no-op in RAM.
   * Deliberately throws on a failed durable delete (unlike a best-effort
   * forget): a rule the admin UI reported as deleted while the row survived
   * is a rule that keeps notifying after the operator believes they stopped it.
   */
  async delete(ruleId: string): Promise<void> {
    this.byId.delete(ruleId)
    try {
      await this.kind.delete(ruleId)
    } catch (err) {
      this.logger.warn('notification rule delete failed', {
        meta: { ruleId, error: String(err) },
      })
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  private async write(rule: NcRule): Promise<void> {
    const { id, ...body } = rule
    await this.kind.put({ id, data: body })
    this.byId.set(id, rule)
  }
}
