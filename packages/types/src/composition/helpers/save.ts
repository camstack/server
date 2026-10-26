/**
 * Save-time checks a pure compile cannot make: the compiled features must be
 * this spec's, and members that report a quantity must share one (D944 §4).
 */
import { DeviceType } from '../../device/device-type.js'
import type { ReadingQuantity } from '../../units/quantity.js'
import { compositionSourceKey, type Composition } from '../composition.js'
import type { CompositionProblem } from '../composition-report.js'
import { problem } from '../plan-result.js'
import { groupTemplate } from './catalog.js'
import { compileHelper, sameHelperBody } from './compile.js'
import type { GroupHelperSpec } from './spec.js'

/** What a save learned about one member device. Absent keys were not read. */
export interface HelperMemberFact {
  readonly deviceType?: DeviceType
  readonly quantity?: ReadingQuantity
}

function quantityProblems(
  spec: GroupHelperSpec,
  facts: ReadonlyMap<string, HelperMemberFact>,
): readonly CompositionProblem[] {
  const template = groupTemplate(spec.templateId)
  if (template === null || template.family !== 'numeric') return []
  const known = spec.members.flatMap((member, index) => {
    const quantity = facts.get(compositionSourceKey(member.source))?.quantity
    return quantity === undefined ? [] : [{ index, quantity }]
  })
  if (template.quantity !== 'device') {
    return known.flatMap((member) =>
      member.quantity === template.quantity
        ? []
        : [
            problem(
              'mixed-quantity',
              `helper.members[${member.index}]`,
              `a ${template.id} group is ${template.quantity}${template.baseUnit === undefined ? '' : ` (${template.baseUnit})`}; this member is ${member.quantity}`,
            ),
          ],
    )
  }
  const distinct = [...new Set(known.map((member) => member.quantity))]
  if (distinct.length <= 1) return []
  return [
    problem(
      'mixed-quantity',
      'helper.members',
      `a numeric group requires one quantity; members report ${distinct.join(' and ')}`,
    ),
  ]
}

function deviceTypeProblems(
  spec: GroupHelperSpec,
  facts: ReadonlyMap<string, HelperMemberFact>,
): readonly CompositionProblem[] {
  const template = groupTemplate(spec.templateId)
  if (template === null) return []
  return spec.members.flatMap((member, index) => {
    const deviceType = facts.get(compositionSourceKey(member.source))?.deviceType
    if (deviceType === undefined || deviceType === template.memberDeviceType) return []
    return [
      problem(
        'member-constraint',
        `helper.members[${index}]`,
        `a ${template.id} group takes ${template.memberDeviceType} devices; this member is a ${deviceType}`,
      ),
    ]
  })
}

/**
 * Problems that refuse a save. No `helper` key means a free composition: this
 * returns nothing, and expression semantics stay as they are.
 */
export function helperSaveProblems(
  composition: Composition,
  facts: ReadonlyMap<string, HelperMemberFact>,
): readonly CompositionProblem[] {
  const spec = composition.helper
  if (spec === undefined) return []
  const compiled = compileHelper(spec)
  if (!compiled.ok) return compiled.problems
  if (!sameHelperBody(composition, compiled.composition)) {
    return [
      problem(
        'helper-mismatch',
        'helper',
        'the stored features are not this template — the helper spec is the only writer',
      ),
    ]
  }
  if (spec.kind === 'appliance') return applianceMemberProblems(spec.member, facts)
  return [...quantityProblems(spec, facts), ...deviceTypeProblems(spec, facts)]
}

function applianceMemberProblems(
  member: GroupHelperSpec['members'][number],
  facts: ReadonlyMap<string, HelperMemberFact>,
): readonly CompositionProblem[] {
  const fact = facts.get(compositionSourceKey(member.source))
  if (fact === undefined) return []
  const problems: CompositionProblem[] = []
  if (
    fact.deviceType !== undefined &&
    fact.deviceType !== DeviceType.Sensor &&
    fact.deviceType !== DeviceType.Switch
  ) {
    problems.push(
      problem(
        'member-constraint',
        'helper.member',
        `an appliance helper reads a sensor or a switch; this member is a ${fact.deviceType}`,
      ),
    )
  }
  if (fact.quantity !== undefined && fact.quantity !== 'power') {
    problems.push(
      problem(
        'mixed-quantity',
        'helper.member',
        `an appliance helper reads power (W); this member is ${fact.quantity}`,
      ),
    )
  }
  return problems
}
