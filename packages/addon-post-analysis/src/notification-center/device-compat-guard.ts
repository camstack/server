/**
 * A NEW or UPDATED rule's `conditions.devices` (the "Only these" INCLUDE list)
 * names only devices that can actually produce this rule's KIND of subject —
 * operator ruling, 2026-10-01: "the DEVICE picker of a rule must offer only
 * devices compatible with the rule type … the server should also refuse a
 * save whose deviceIds include an incompatible device".
 *
 * THE authority, same arrangement as `device-scope-guard.ts` beside it: the
 * cap-provider route (`notificationRules.createRule/updateRule`, index.ts)
 * and the rule bridge (`nc.createRule/updateRule`, nc-actions.ts) both call
 * `guardRuleDeviceCompat` / `guardPatchDeviceCompat`. Which devices a kind
 * may scope is `ruleDeviceCompatCapQueries` (`@camstack/types`) — the SAME
 * table the admin's Devices tab narrows by, so a save can never refuse a
 * device its own picker just offered. A `sensor` rule's set includes every
 * camera: a camera-scoped sensor rule is legitimate (D630 §6).
 *
 * ASYNC, unlike its sibling guards: it has to ask `deviceManager` which
 * devices carry the caps. `listDeviceIdsByCaps` is therefore OPTIONAL on the
 * context — absent on an older wiring, if the cross-addon call throws, or if
 * it answers EMPTY (the registry not yet warm at boot: `getAllBindings`
 * answers `[]` with only a warning, which is not a measurement — D315/D393),
 * the guard FAILS OPEN (never refuses) rather than blocking every save on a
 * read it cannot make (D49). It is never SILENT about it: an unjudged scoped
 * save logs a sampled WARN naming the rule and the reason, so a dropped wiring
 * is visible in production rather than a guard that quietly stopped existing.
 *
 * ON UPDATE only the ids the patch ADDS are judged. A device already stored on
 * the rule is never re-judged: the answer is not stable (switching detection
 * off on a camera removes its `detection-pipeline` binding, D62; an agent
 * camera's native caps are missing during the handshake), and re-judging
 * would make every rule naming that camera un-editable until the operator
 * removed it — losing a scope a later switch-on would not give back.
 *
 * NEVER called at LOAD. `NcRuleSchema.parse` and the store's own read path are
 * untouched — a rule saved before this ruling, or saved while the capability
 * read was unavailable, keeps loading and keeps firing exactly as it does
 * today; only a NEW save attempt is judged.
 *
 * `devicesExclude` is NOT checked: this guard judges what the rule actually
 * MATCHES ON (the include scope), not what it widens away from, and an
 * operator excluding an incompatible device from an "all except" rule is not
 * the mistake this exists to catch.
 */
import { type IScopedLogger, ruleDeviceCompatCapQueries, ruleKindOf } from '@camstack/types'
import {
  mergedFamilySubject,
  type NcRuleFamilyGuardContext,
  type NcRuleFamilyPatch,
  type NcRuleFamilySubject,
} from './rule-family-guard.js'

/** Asks which device ids carry ANY of the given capability names. */
export type ListDeviceIdsByCaps = (capNames: readonly string[]) => Promise<readonly number[]>

/** Why a scoped save went through WITHOUT being judged. */
export type NcDeviceCompatUncheckedReason = 'unwired' | 'read-failed' | 'answered-empty'

/** What the check concluded, when it did not refuse. */
export type NcDeviceCompatVerdict =
  /** Nothing to judge: no filter for this kind, or no device scoped/added. */
  | { readonly outcome: 'not-judged' }
  | { readonly outcome: 'compatible' }
  /** Accepted UNJUDGED (fail open, D49) — the caller must say so. */
  | {
      readonly outcome: 'unchecked'
      readonly reason: NcDeviceCompatUncheckedReason
      readonly ids: readonly number[]
      readonly error?: string
    }

/** How long one rule's "accepted unchecked" WARN stays quiet after it fired. */
const UNCHECKED_WARN_WINDOW_MS = 10 * 60_000
/** Bound on remembered rule keys — cleared whole when exceeded. */
const UNCHECKED_WARN_MEMO_MAX = 256

/**
 * Samples the "accepted unchecked" WARN per rule: an editor that autosaves, or
 * a script, must not turn one unreachable read into a log flood, but the first
 * save of every rule in a window is always reported.
 */
export class NcDeviceCompatWarnSampler {
  private readonly lastWarnedAt = new Map<string, number>()

  shouldWarn(key: string, now: number): boolean {
    const last = this.lastWarnedAt.get(key)
    if (last !== undefined && now - last < UNCHECKED_WARN_WINDOW_MS) return false
    if (this.lastWarnedAt.size >= UNCHECKED_WARN_MEMO_MAX) this.lastWarnedAt.clear()
    this.lastWarnedAt.set(key, now)
    return true
  }
}

export interface NcDeviceCompatGuardContext extends NcRuleFamilyGuardContext {
  readonly listDeviceIdsByCaps?: ListDeviceIdsByCaps
  /** Absent ⇒ every unchecked save warns. */
  readonly sampler?: NcDeviceCompatWarnSampler
  readonly now?: () => number
}

export class NcDeviceCompatRefusal extends Error {
  readonly kind: string
  readonly incompatibleIds: readonly number[]
  constructor(kind: string, incompatibleIds: readonly number[]) {
    super(
      `rule refused: device(s) ${incompatibleIds.join(', ')} cannot produce a '${kind}' rule's subject`,
    )
    this.name = 'NcDeviceCompatRefusal'
    this.kind = kind
    this.incompatibleIds = incompatibleIds
  }
}

/** The union of every compat query's answer, or why there is none. */
async function readCompatibleIds(
  queries: readonly (readonly string[])[],
  listDeviceIdsByCaps: ListDeviceIdsByCaps,
): Promise<
  | { readonly ok: true; readonly ids: ReadonlySet<number> }
  | { readonly ok: false; readonly error: string }
> {
  try {
    const answers = await Promise.all(queries.map((capNames) => listDeviceIdsByCaps(capNames)))
    return { ok: true, ids: new Set(answers.flat()) }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/**
 * The check. `judged` is the ids to judge — the whole include list on a
 * create, only the ADDED ids on an update (see the file header).
 *
 * Resolves `not-judged` when the kind has no capability filter
 * (`ruleDeviceCompatCapQueries` is `null`) or there is nothing to judge —
 * "every device" is never refused here. Resolves `unchecked` (fail open) when
 * the read is not wired, throws, or answers nothing at all. Throws
 * {@link NcDeviceCompatRefusal} naming every incompatible id, never only the
 * first — an operator fixing the list needs the whole picture in one pass.
 */
export async function assertRuleDeviceCompat(
  rule: NcRuleFamilySubject,
  listDeviceIdsByCaps: ListDeviceIdsByCaps | undefined,
  judged: readonly number[] = rule.conditions.devices ?? [],
): Promise<NcDeviceCompatVerdict> {
  const kind = ruleKindOf(rule)
  const queries = ruleDeviceCompatCapQueries(kind)
  if (queries === null || judged.length === 0) return { outcome: 'not-judged' }
  if (listDeviceIdsByCaps === undefined) {
    return { outcome: 'unchecked', reason: 'unwired', ids: judged }
  }
  const read = await readCompatibleIds(queries, listDeviceIdsByCaps)
  if (!read.ok) {
    return { outcome: 'unchecked', reason: 'read-failed', ids: judged, error: read.error }
  }
  if (read.ids.size === 0) return { outcome: 'unchecked', reason: 'answered-empty', ids: judged }
  const incompatible = judged.filter((id) => !read.ids.has(id))
  if (incompatible.length > 0) throw new NcDeviceCompatRefusal(kind, incompatible)
  return { outcome: 'compatible' }
}

/**
 * Run the check and report what it could not do: a refusal is dropped work, so
 * it is logged before it is rethrown; an unchecked acceptance is a guard that
 * did not run, so it is logged (sampled) too.
 */
async function runAndReport(
  rule: NcRuleFamilySubject,
  judged: readonly number[],
  ctx: NcDeviceCompatGuardContext,
): Promise<void> {
  let verdict: NcDeviceCompatVerdict
  try {
    verdict = await assertRuleDeviceCompat(rule, ctx.listDeviceIdsByCaps, judged)
  } catch (err) {
    if (err instanceof NcDeviceCompatRefusal) warnRefusal(ctx.logger, err, ctx)
    throw err
  }
  if (verdict.outcome === 'unchecked') warnUnchecked(ruleKindOf(rule), verdict, ctx)
}

function warnRefusal(
  logger: IScopedLogger,
  err: NcDeviceCompatRefusal,
  ctx: NcDeviceCompatGuardContext,
): void {
  logger.warn('nc rule refused: device(s) incompatible with the rule kind', {
    meta: {
      ...(ctx.ruleId !== undefined ? { ruleId: ctx.ruleId } : {}),
      by: ctx.by,
      kind: err.kind,
      incompatibleIds: [...err.incompatibleIds],
    },
  })
}

function warnUnchecked(
  kind: string,
  verdict: Extract<NcDeviceCompatVerdict, { readonly outcome: 'unchecked' }>,
  ctx: NcDeviceCompatGuardContext,
): void {
  const now = (ctx.now ?? Date.now)()
  const key = `${ctx.ruleId ?? `new:${ctx.by}`}:${verdict.reason}`
  if (ctx.sampler !== undefined && !ctx.sampler.shouldWarn(key, now)) return
  ctx.logger.warn('nc rule saved WITHOUT the device-compatibility check — accepted unchecked', {
    meta: {
      ...(ctx.ruleId !== undefined ? { ruleId: ctx.ruleId } : {}),
      by: ctx.by,
      kind,
      reason: verdict.reason,
      uncheckedIds: [...verdict.ids],
      ...(verdict.error !== undefined ? { error: verdict.error } : {}),
    },
  })
}

/** The create path: the whole include list is judged. */
export async function guardRuleDeviceCompat(
  rule: NcRuleFamilySubject,
  ctx: NcDeviceCompatGuardContext,
): Promise<void> {
  await runAndReport(rule, rule.conditions.devices ?? [], ctx)
}

/**
 * The update path: the MERGED rule decides the kind, but only the ids the
 * patch ADDS to `conditions.devices` are judged — a stored id is never
 * re-judged (see the file header). A patch that adds nothing never pays for a
 * capability read.
 */
export async function guardPatchDeviceCompat(
  existing: NcRuleFamilySubject | null,
  patch: NcRuleFamilyPatch,
  ctx: NcDeviceCompatGuardContext,
): Promise<void> {
  if (existing === null) return
  const merged = mergedFamilySubject(existing, patch)
  if (merged === null) return
  const stored = new Set(existing.conditions.devices ?? [])
  const added = (merged.conditions.devices ?? []).filter((id) => !stored.has(id))
  await runAndReport(merged, added, ctx)
}
