/**
 * The hub's half of R13 (D690): a DETECTION rule does not name sounds.
 *
 * An `audio-*` class in `classes` / `classesExclude` of a rule that carries no
 * `conditions.audio` is the legacy one-sample audio path — a detection rule
 * the editors used to let an operator "add a sound" to, which then fired on a
 * single classified sample, or on nothing the operator meant. Sounds are a
 * Sound rule of their own (`conditions.audio`), and both editors no longer
 * offer an audio class on a detection rule.
 *
 * A NEW or UPDATED rule that still carries one is refused, loudly, on both save
 * routes — the cap provider (`notificationRules.createRule/updateRule`,
 * index.ts) and the rule bridge (`nc.createRule/updateRule`, nc-actions.ts) —
 * beside the D637/D640 guards, judged on the same merged rule
 * (`mergedFamilySubject`), so a save that leaves delivery and conditions as
 * stored (a rename, a switch-off) is never re-judged.
 *
 * Not in Zod, for the reason `rule-family-guard.ts` gives: a refine on the
 * conditions schema would also run at LOAD, and a rule stored before D690 must
 * keep loading and keep firing exactly as it did. The loader reports those
 * instead ({@link NcRuleStore.load} → {@link warnLegacyAudioClassRules}).
 */
import type { IScopedLogger, NcRule } from '@camstack/types'
import { isAudioClassName, isSystemDelivery } from '@camstack/types'
import {
  mergedFamilySubject,
  type NcRuleFamilyGuardContext,
  type NcRuleFamilyPatch,
  type NcRuleFamilySubject,
} from './rule-family-guard.js'

export class NcDetectionAudioRefusal extends Error {
  readonly audioClasses: readonly string[]
  constructor(audioClasses: readonly string[]) {
    super(
      `rule refused: a detection rule cannot name sounds (${audioClasses.join(', ')}) — create a Sound rule for them`,
    )
    this.name = 'NcDetectionAudioRefusal'
    this.audioClasses = audioClasses
  }
}

/**
 * The audio classes a DETECTION rule carries (include and exclude), in stored
 * order. Empty for a Sound rule (its `audio` condition owns its sounds) and for
 * a system rule (it has no class scope).
 */
export function audioClassesOnDetectionRule(rule: NcRuleFamilySubject): readonly string[] {
  if (isSystemDelivery(rule.delivery)) return []
  if (rule.conditions.audio !== undefined) return []
  const named = [...(rule.conditions.classes ?? []), ...(rule.conditions.classesExclude ?? [])]
  return named.filter(isAudioClassName)
}

export function assertNoAudioClassOnDetectionRule(rule: NcRuleFamilySubject): void {
  const audioClasses = audioClassesOnDetectionRule(rule)
  if (audioClasses.length > 0) throw new NcDetectionAudioRefusal(audioClasses)
}

/** Run the check; a refusal is dropped work, so it is logged before it is rethrown. */
function logRefusal(check: () => void, ctx: NcRuleFamilyGuardContext): void {
  try {
    check()
  } catch (err) {
    if (err instanceof NcDetectionAudioRefusal) warnRefusal(ctx.logger, err, ctx)
    throw err
  }
}

function warnRefusal(
  logger: IScopedLogger,
  err: NcDetectionAudioRefusal,
  ctx: NcRuleFamilyGuardContext,
): void {
  logger.warn('nc rule refused: a detection rule names sounds', {
    meta: {
      ...(ctx.ruleId !== undefined ? { ruleId: ctx.ruleId } : {}),
      by: ctx.by,
      audioClasses: err.audioClasses.join(', '),
    },
  })
}

/** The create path of both routes. */
export function guardRuleDetectionAudio(
  rule: NcRuleFamilySubject,
  ctx: NcRuleFamilyGuardContext,
): void {
  logRefusal(() => assertNoAudioClassOnDetectionRule(rule), ctx)
}

/**
 * The update path of both routes: the MERGED rule, only when the patch changes
 * it — and only the sounds the save ADDS. A legacy rule that already names a
 * sound stays editable (a threshold, a schedule, a zone); what is refused is
 * naming a new one.
 */
export function guardPatchDetectionAudio(
  existing: NcRuleFamilySubject | null,
  patch: NcRuleFamilyPatch,
  ctx: NcRuleFamilyGuardContext,
): void {
  if (existing === null) return
  const merged = mergedFamilySubject(existing, patch)
  if (merged === null) return
  const stored = new Set(audioClassesOnDetectionRule(existing).map(normalisedClass))
  const added = audioClassesOnDetectionRule(merged).filter(
    (name) => !stored.has(normalisedClass(name)),
  )
  if (added.length === 0) return
  logRefusal(() => {
    throw new NcDetectionAudioRefusal(added)
  }, ctx)
}

function normalisedClass(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * The loader's half: every stored detection rule that names a sound is KEPT
 * (it loads and fires as it always did) and reported at WARN with its id —
 * once per rule per process, never on every reload tick. Returns the ids it
 * reported this time, for the caller's bookkeeping.
 */
export function warnLegacyAudioClassRules(
  rules: readonly NcRule[],
  alreadyWarned: ReadonlySet<string>,
  logger: IScopedLogger,
): readonly string[] {
  const reported: string[] = []
  for (const rule of rules) {
    if (alreadyWarned.has(rule.id)) continue
    const audioClasses = audioClassesOnDetectionRule(rule)
    if (audioClasses.length === 0) continue
    logger.warn(
      'notification rule is a detection rule naming sounds — kept as it is; recreate it as a Sound rule',
      {
        meta: { ruleId: rule.id, name: rule.name, audioClasses: audioClasses.join(', ') },
      },
    )
    reported.push(rule.id)
  }
  return reported
}
