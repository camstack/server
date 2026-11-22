/**
 * The automation a group's triggers become. Pure: the caller (core-blocks)
 * hands in a resolver from stable refs to numeric device ids, and writes the
 * result as the one block the group owns. Nothing here reads or writes a store.
 *
 * Shape: `when` is an `any` of one event leaf per trigger (the leaf id is the
 * trigger id), and each trigger has its own top-level `choose` guarded by
 * `triggered-by` its leaf — one `choose` per trigger because a `choose` holds
 * six branches at most and a group up to sixteen triggers.
 *
 * Output `device`: every action commands the group device, whose own fan-out
 * and aggregate do the rest. Output `none`: there is no group device, so the
 * actions command the members directly; `switch` (toggle) is decided here from
 * the members' state with the same rule as the aggregate (`reducerForActive`):
 * the group reads as on when any member is on (`at-least-one`) or every member
 * is on (`all`); on → off, otherwise → on. A step condition cannot leave an
 * unread member out (D49 — an unread state runs nothing), so a member whose
 * state is unknown makes the toggle a traced no-op instead of being skipped.
 */
import type { AutomationWhen } from '../../automation/when.js'
import {
  type AutomationAction,
  type AutomationBodyStep,
  type AutomationRecipe,
} from '../../automation/recipe.js'
import { composedDeviceStableId } from '../composition.js'
import type { CompositionSourceRef } from '../source-ref.js'
import { reducerForActive } from './actuator.js'
import {
  type GroupTrigger,
  type GroupTriggerAction,
  type GroupTriggerSource,
  triggerEnabled,
} from './group-triggers.js'
import type { GroupHelperSpec } from './spec.js'

const COMPOSER_ADDON = 'composer'
const RUN_MODE_QUEUE = 5

export type DeviceIdResolver = (ref: CompositionSourceRef) => number | null

export interface GroupTriggerLeftOut {
  readonly triggerId: string
  readonly reason: string
}

export interface GroupTriggerRecipe {
  /** Null when no enabled trigger could be written. */
  readonly recipe: AutomationRecipe | null
  readonly leftOut: readonly GroupTriggerLeftOut[]
}

export interface GroupTriggerRecipeInput {
  readonly blockId: string
  readonly helper: GroupHelperSpec
  readonly resolve: DeviceIdResolver
}

type CommandStep = Extract<AutomationBodyStep, { kind: 'command' }>

function describe(ref: CompositionSourceRef): string {
  return `${ref.addonId}/${ref.stableId}`
}

/** The event leaf of one trigger, or why it cannot be written. */
function leafOf(
  trigger: GroupTrigger,
  resolve: DeviceIdResolver,
): { readonly leaf: AutomationWhen } | { readonly reason: string } {
  const source: GroupTriggerSource = trigger.source
  const id = trigger.id
  switch (source.kind) {
    case 'fired': {
      const deviceId = resolve(source.device)
      if (deviceId === null) return { reason: `${describe(source.device)} is not a known device` }
      return {
        leaf: {
          kind: 'device-fired',
          id,
          deviceId,
          ...(source.eventIds === undefined ? {} : { eventIds: source.eventIds }),
          ...(source.sourceIds === undefined ? {} : { sourceIds: source.sourceIds }),
          ...(source.kinds === undefined ? {} : { kinds: source.kinds }),
          ...(source.match === undefined ? {} : { match: source.match }),
        },
      }
    }
    case 'event': {
      if (source.device === undefined) {
        return { leaf: { kind: 'device-event', id, category: source.category } }
      }
      const deviceId = resolve(source.device)
      if (deviceId === null) return { reason: `${describe(source.device)} is not a known device` }
      return { leaf: { kind: 'device-event', id, category: source.category, deviceId } }
    }
    case 'detection': {
      const deviceIds = source.devices
        .map((device) => resolve(device))
        .filter((deviceId): deviceId is number => deviceId !== null)
      if (deviceIds.length === 0) {
        return { reason: `none of ${source.devices.map(describe).join(', ')} is a known device` }
      }
      return {
        leaf: {
          kind: 'detection',
          id,
          subjects: source.subjects,
          deviceIds,
          ...(source.zones === undefined ? {} : { zones: source.zones }),
          ...(source.minScore === undefined ? {} : { minScore: source.minScore }),
        },
      }
    }
    case 'becomes': {
      const deviceId = resolve(source.device)
      if (deviceId === null) return { reason: `${describe(source.device)} is not a known device` }
      return {
        leaf: {
          kind: 'device-becomes',
          id,
          deviceId,
          cap: source.cap,
          fieldPath: source.fieldPath,
          becomes: source.becomes,
        },
      }
    }
  }
}

function command(
  ids: readonly number[],
  actionId: string,
  args?: Readonly<Record<string, unknown>>,
): CommandStep {
  return {
    kind: 'command',
    target: { kind: 'devices', ids: [...ids] },
    actionId,
    ...(args === undefined ? {} : { args: { ...args } }),
  }
}

function climateCommands(
  ids: readonly number[],
  action: Extract<GroupTriggerAction, { kind: 'climate' }>,
): readonly CommandStep[] {
  return [
    ...(action.mode === undefined ? [] : [command(ids, 'climate.mode', { mode: action.mode })]),
    ...(action.target === undefined
      ? []
      : [command(ids, 'climate.target', { target: action.target })]),
  ]
}

interface MemberState {
  readonly deviceId: number
  readonly cap: string
  readonly fieldPath: string
}

function memberIs(member: MemberState, value: boolean): AutomationWhen {
  return {
    kind: 'device-is',
    deviceId: member.deviceId,
    cap: member.cap,
    fieldPath: member.fieldPath,
    operator: 'eq',
    value,
  }
}

function anyMember(members: readonly MemberState[], value: boolean): AutomationWhen {
  return { kind: 'any', children: members.map((member) => memberIs(member, value)) }
}

/** The group reads as on: the aggregate's `any` or `all` over the booleans, as a state tree. */
function groupIsOn(
  members: readonly MemberState[],
  active: GroupHelperSpec['active'],
): AutomationWhen {
  if (reducerForActive(active ?? 'at-least-one') === 'any') return anyMember(members, true)
  return {
    kind: 'all',
    children: [anyMember(members, true), { kind: 'not', child: anyMember(members, false) }],
  }
}

function memberToggle(
  ids: readonly number[],
  members: readonly MemberState[],
  active: GroupHelperSpec['active'],
): AutomationBodyStep {
  return {
    kind: 'choose',
    branches: [
      { if: groupIsOn(members, active), steps: [command(ids, 'switch.off')] },
      { if: anyMember(members, false), steps: [command(ids, 'switch.on')] },
    ],
  }
}

interface ActionContext {
  readonly ids: readonly number[]
  /** Members as state readers: only the `none` output toggles from them. */
  readonly members: readonly MemberState[] | null
  readonly active: GroupHelperSpec['active']
}

function stepsOf(action: GroupTriggerAction, ctx: ActionContext): readonly AutomationBodyStep[] {
  switch (action.kind) {
    case 'on':
      return [command(ctx.ids, 'switch.on')]
    case 'off':
      return [command(ctx.ids, 'switch.off')]
    case 'switch':
      return ctx.members === null
        ? [command(ctx.ids, 'switch.toggle')]
        : [memberToggle(ctx.ids, ctx.members, ctx.active)]
    case 'climate':
      return climateCommands(ctx.ids, action)
  }
}

function chooseFor(trigger: GroupTrigger, ctx: ActionContext): AutomationAction {
  return {
    kind: 'choose',
    branches: [
      {
        if: { kind: 'triggered-by', leafIds: [trigger.id] },
        steps: [...stepsOf(trigger.action, ctx)],
      },
    ],
  }
}

function resolvedMembers(input: GroupTriggerRecipeInput): readonly MemberState[] {
  return input.helper.members.flatMap((member): readonly MemberState[] => {
    const deviceId = input.resolve(member.source)
    return deviceId === null
      ? []
      : [{ deviceId, cap: member.cap ?? 'switch', fieldPath: member.fieldPath ?? 'on' }]
  })
}

/** What the actions command, or the reason there is nothing to command. */
function actionContext(
  input: GroupTriggerRecipeInput,
): { readonly ctx: ActionContext } | { readonly reason: string } {
  const active = input.helper.active
  if (input.helper.output === 'none') {
    const members = resolvedMembers(input)
    if (members.length === 0) return { reason: 'none of the members is a known device' }
    return { ctx: { ids: members.map((member) => member.deviceId), members, active } }
  }
  const self: CompositionSourceRef = {
    addonId: COMPOSER_ADDON,
    stableId: composedDeviceStableId(input.blockId),
  }
  const groupId = input.resolve(self)
  if (groupId === null) return { reason: 'the group device is not built yet' }
  return { ctx: { ids: [groupId], members: null, active } }
}

export function groupTriggerRecipe(input: GroupTriggerRecipeInput): GroupTriggerRecipe {
  const enabled = (input.helper.triggers ?? []).filter(triggerEnabled)
  if (enabled.length === 0) return { recipe: null, leftOut: [] }
  const target = actionContext(input)
  if ('reason' in target) {
    return {
      recipe: null,
      leftOut: enabled.map((trigger) => ({ triggerId: trigger.id, reason: target.reason })),
    }
  }
  const leaves: AutomationWhen[] = []
  const actions: AutomationAction[] = []
  const leftOut: GroupTriggerLeftOut[] = []
  for (const trigger of enabled) {
    const made = leafOf(trigger, input.resolve)
    if ('reason' in made) {
      leftOut.push({ triggerId: trigger.id, reason: made.reason })
      continue
    }
    leaves.push(made.leaf)
    actions.push(chooseFor(trigger, target.ctx))
  }
  if (leaves.length === 0) return { recipe: null, leftOut }
  return {
    recipe: {
      when: { kind: 'any', children: leaves },
      actions,
      runMode: { mode: 'queued', max: RUN_MODE_QUEUE },
      ownedBy: { kind: 'group', blockId: input.blockId },
    },
    leftOut,
  }
}
