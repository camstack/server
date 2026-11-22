import { describe, expect, it } from 'vitest'
import { climateControlCapability } from '../../../capabilities/climate-control.cap.js'
import { contactCapability } from '../../../capabilities/contact.cap.js'
import { groupActiveCapability } from '../../../capabilities/group-active.cap.js'
import { groupStatusCapability } from '../../../capabilities/group-status.cap.js'
import { switchCapability } from '../../../capabilities/switch.cap.js'
import { DeviceType } from '../../../device/device-type.js'
import { EventCategory } from '../../../enums/event-category.js'
import { compositionSourceKey, type Composition } from '../../composition.js'
import {
  buildCapabilityLookup,
  type CompositionSourceDescription,
  type ValidateCompositionContext,
  validateComposition,
} from '../../validate-composition.js'
import { groupTemplate } from '../catalog.js'
import { compileHelper } from '../compile.js'
import {
  GroupTriggersSchema,
  MAX_GROUP_TRIGGERS,
  type GroupTrigger,
  triggerSourceRefs,
} from '../group-triggers.js'
import {
  type GroupHelperSpec,
  type GroupTemplateId,
  helperBuildsNoDevice,
  helperMembers,
} from '../spec.js'

const lookupCap = buildCapabilityLookup([
  switchCapability,
  contactCapability,
  groupStatusCapability,
  groupActiveCapability,
  climateControlCapability,
])

const BUTTON = { addonId: 'provider-demo', stableId: 'button-1' }

function pressOn(id: string, action: GroupTrigger['action'] = { kind: 'switch' }): GroupTrigger {
  return {
    id,
    source: { kind: 'fired', device: BUTTON, eventIds: ['PRESS_SHORT'], sourceIds: ['1'] },
    action,
  }
}

function group(templateId: GroupTemplateId, triggers: readonly GroupTrigger[]): GroupHelperSpec {
  const template = groupTemplate(templateId)
  const field = template?.accept[0]
  if (field === undefined) throw new Error(`no member field for ${templateId}`)
  return {
    kind: 'group',
    templateId,
    aggregate: template?.family === 'actuator' ? 'any' : 'mean',
    ...(template?.family === 'actuator' ? { active: 'at-least-one' as const } : {}),
    members: [
      {
        source: { addonId: 'provider-demo', stableId: `${templateId}-1` },
        cap: field.cap,
        fieldPath: field.fieldPath,
      },
    ],
    triggers: [...triggers],
  }
}

function problemsOf(spec: GroupHelperSpec): readonly string[] {
  const compiled = compileHelper(spec)
  if (!compiled.ok) throw new Error('did not compile')
  const composition: Composition = compiled.composition
  const template = groupTemplate(spec.templateId)
  const sources = new Map<string, CompositionSourceDescription>()
  for (const [index, item] of helperMembers(spec).entries()) {
    sources.set(compositionSourceKey(item.source), {
      kind: 'found',
      deviceId: 5000 + index,
      caps: new Set([item.cap]),
      deviceType: template?.deviceType ?? DeviceType.Switch,
      quantity: 'none',
    })
  }
  const context: ValidateCompositionContext = {
    lookupCap,
    sources,
    self: null,
    blockId: null,
    target: null,
    peers: [],
  }
  return validateComposition(composition, context)
    .problems.filter((item) => item.code === 'group-trigger')
    .map((item) => `${item.path}: ${item.message}`)
}

describe('group trigger schema', () => {
  it('accepts a press, an event, a detection and a becomes source', () => {
    const parsed = GroupTriggersSchema.safeParse([
      pressOn('t-ch1'),
      {
        id: 'bell',
        source: { kind: 'event', category: EventCategory.DoorbellOnPressed },
        action: { kind: 'on' },
      },
      {
        id: 'door',
        source: {
          kind: 'becomes',
          device: BUTTON,
          cap: 'contact',
          fieldPath: 'entryOpen',
          becomes: true,
        },
        action: { kind: 'off' },
      },
    ])
    expect(parsed.success).toBe(true)
  })

  it('refuses a duplicate id, a bad id, too many triggers and an empty climate action', () => {
    expect(GroupTriggersSchema.safeParse([pressOn('a'), pressOn('a')]).success).toBe(false)
    expect(GroupTriggersSchema.safeParse([pressOn('Bad Id')]).success).toBe(false)
    const many = Array.from({ length: MAX_GROUP_TRIGGERS + 1 }, (_, i) => pressOn(`t${i}`))
    expect(GroupTriggersSchema.safeParse(many).success).toBe(false)
    expect(GroupTriggersSchema.safeParse([pressOn('c', { kind: 'climate' })]).success).toBe(false)
    expect(
      GroupTriggersSchema.safeParse([pressOn('c', { kind: 'climate', target: 21 })]).success,
    ).toBe(true)
  })

  it('names every device a trigger listens to', () => {
    expect(triggerSourceRefs(pressOn('a'))).toEqual([BUTTON])
    expect(
      triggerSourceRefs({
        id: 'e',
        source: { kind: 'event', category: EventCategory.DoorbellOnPressed },
        action: { kind: 'on' },
      }),
    ).toEqual([])
  })
})

describe('a group without a device', () => {
  it('needs an enabled trigger: zero triggers, or only disabled ones, are refused', () => {
    const none = (triggers: readonly GroupTrigger[]): GroupHelperSpec => ({
      ...group('light', triggers),
      output: 'none',
    })
    const refusal =
      'helper.output: a group without a device needs at least one enabled trigger — it would do nothing'
    expect(problemsOf(none([]))).toEqual([refusal])
    expect(problemsOf(none([{ ...pressOn('a'), enabled: false }]))).toEqual([refusal])
    expect(problemsOf(none([pressOn('a')]))).toEqual([])
  })

  it('is only the output of a group that says so', () => {
    expect(helperBuildsNoDevice({ ...group('light', [pressOn('a')]), output: 'none' })).toBe(true)
    expect(helperBuildsNoDevice(group('light', [pressOn('a')]))).toBe(false)
    expect(helperBuildsNoDevice(undefined)).toBe(false)
  })
})

describe('group trigger refusals, by name', () => {
  it('lets a light group take on / off / switch and keeps the save green', () => {
    expect(problemsOf(group('light', [pressOn('a'), pressOn('b', { kind: 'on' })]))).toEqual([])
  })

  it('refuses a climate action on a light group, and a switch action on a climate group', () => {
    expect(problemsOf(group('light', [pressOn('a', { kind: 'climate', target: 20 })]))).toEqual([
      'helper.triggers[0].action: trigger "a": a light group cannot set a climate mode or target',
    ])
    expect(problemsOf(group('climate', [pressOn('a', { kind: 'on' })]))).toEqual([
      'helper.triggers[0].action: trigger "a": a climate group cannot do "on"',
    ])
    expect(problemsOf(group('climate', [pressOn('a', { kind: 'climate', mode: 'heat' })]))).toEqual(
      [],
    )
  })

  it('refuses triggers on a cover group and on a reading group (v1)', () => {
    expect(problemsOf(group('cover', [pressOn('a')]))).toEqual([
      'helper.triggers: triggers are not available for a cover group yet',
    ])
    expect(problemsOf(group('temperature', [pressOn('a')]))).toEqual([
      'helper.triggers: triggers are for actuator groups',
    ])
  })

  it('refuses a becomes source that is not a yes/no field of a known cap', () => {
    const becomes = (cap: string, fieldPath: string): GroupTrigger => ({
      id: 'b',
      source: { kind: 'becomes', device: BUTTON, cap, fieldPath, becomes: true },
      action: { kind: 'on' },
    })
    expect(problemsOf(group('light', [becomes('contact', 'entryOpen')]))).toEqual([])
    expect(problemsOf(group('light', [becomes('nope', 'entryOpen')]))).toEqual([
      'helper.triggers[0].source.cap: trigger "b": "nope" is not a capability with a state',
    ])
    expect(problemsOf(group('light', [becomes('switch', 'lastChangedAt')]))).toEqual([
      'helper.triggers[0].source.fieldPath: trigger "b": switch.lastChangedAt is not a yes/no field',
    ])
  })
})
