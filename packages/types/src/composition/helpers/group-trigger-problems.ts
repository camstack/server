/**
 * What a save refuses about the triggers of an actuator group, by name. Its own
 * file: it reads the catalog, which the spec (and so the trigger schema) must
 * not import.
 */
import type { CapabilityLookup } from '../validate-composition.js'
import type { CompositionProblem } from '../composition-report.js'
import { problem } from '../plan-result.js'
import { describeStateField } from '../state-fields.js'
import { groupTemplate } from './catalog.js'
import type { GroupTrigger, GroupTriggerSource } from './group-triggers.js'
import type { HelperSpec } from './spec.js'

const SWITCH_ACTION_TEMPLATES: ReadonlySet<string> = new Set(['switch', 'light', 'fan'])
/** v1: only these group types take triggers (a cover, valve, lock or player does not). */
const TRIGGER_TEMPLATES: ReadonlySet<string> = new Set(['switch', 'light', 'fan', 'climate'])

/**
 * Triggers on a group that is not an actuator
 * group, a type that does not take triggers yet, an action the type cannot do,
 * and a `becomes` source whose field is not a boolean of a known cap.
 */
export function groupTriggerProblems(
  helper: HelperSpec | undefined,
  triggers: readonly GroupTrigger[] | undefined,
  lookupCap: CapabilityLookup,
): readonly CompositionProblem[] {
  const noDevice = helper?.kind === 'group' && helper.output === 'none'
  if (noDevice && (triggers === undefined || !triggers.some((t) => t.enabled !== false))) {
    return [
      problem(
        'group-trigger',
        'helper.output',
        'a group without a device needs at least one enabled trigger — it would do nothing',
      ),
    ]
  }
  if (triggers === undefined || triggers.length === 0) return []
  if (helper === undefined || helper.kind !== 'group') {
    return [problem('group-trigger', 'helper.triggers', 'triggers are for actuator groups')]
  }
  const template = groupTemplate(helper.templateId)
  if (template === null || template.family !== 'actuator') {
    return [problem('group-trigger', 'helper.triggers', 'triggers are for actuator groups')]
  }
  if (!TRIGGER_TEMPLATES.has(helper.templateId)) {
    return [
      problem(
        'group-trigger',
        'helper.triggers',
        `triggers are not available for a ${helper.templateId} group yet`,
      ),
    ]
  }
  return triggers.flatMap((trigger, index) =>
    oneTriggerProblems(trigger, `helper.triggers[${index}]`, helper.templateId, lookupCap),
  )
}

function oneTriggerProblems(
  trigger: GroupTrigger,
  at: string,
  templateId: string,
  lookupCap: CapabilityLookup,
): readonly CompositionProblem[] {
  const found: CompositionProblem[] = []
  const action = trigger.action
  const switchAction = action.kind !== 'climate'
  if (switchAction !== SWITCH_ACTION_TEMPLATES.has(templateId)) {
    found.push(
      problem(
        'group-trigger',
        `${at}.action`,
        `trigger "${trigger.id}": a ${templateId} group cannot ${action.kind === 'climate' ? 'set a climate mode or target' : `do "${action.kind}"`}`,
      ),
    )
  }
  if (trigger.source.kind === 'becomes') {
    found.push(...becomesProblems(trigger.id, trigger.source, at, lookupCap))
  }
  return found
}

function becomesProblems(
  id: string,
  source: Extract<GroupTriggerSource, { kind: 'becomes' }>,
  at: string,
  lookupCap: CapabilityLookup,
): readonly CompositionProblem[] {
  const def = lookupCap(source.cap)
  if (def === null || def.runtimeState === undefined) {
    return [
      problem(
        'group-trigger',
        `${at}.source.cap`,
        `trigger "${id}": "${source.cap}" is not a capability with a state`,
      ),
    ]
  }
  const field = describeStateField(def.runtimeState, source.fieldPath)
  if (field === null || field.kind !== 'boolean') {
    return [
      problem(
        'group-trigger',
        `${at}.source.fieldPath`,
        `trigger "${id}": ${source.cap}.${source.fieldPath} is not a yes/no field`,
      ),
    ]
  }
  return []
}
