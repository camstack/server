/**
 * Live actuator helpers (D944). State is the aggregate the composer already
 * runs. Commands are fanned out here: every member that binds the cap,
 * including one that is offline, and a failure on one does not cancel the rest.
 * What a group offers is its type's method table intersected over the members
 * (a light's colour, a cover's tilt, a fan's speed): recomputed when a member's
 * bindings change, and a call for a method outside it is refused by name.
 * Unlocking a group is refused unless the call carries `confirm: true`.
 */
import {
  type CompositionSourceRef,
  type DeviceFeature,
  type FanOutCall,
  type FanOutMember,
  type ActuatorMethodRow,
  type ActuatorTemplateId,
  type GroupCommandResult,
  type HelperMember,
  type HelperSpec,
  type IScopedLogger,
  ACTUATOR_METHODS,
  ACTUATOR_TEMPLATE_IDS,
  fanOutTargets,
  groupTemplate,
  methodRefusal,
  runFanOut,
  sharedActuatorFeatures,
  sharedActuatorMethods,
  sharedColorModes,
} from '@camstack/types'
import { type ActuatorDispatchInput, setActuatorDispatcher } from './actuator-dispatch.js'

export interface ActuatorMemberReady {
  readonly kind: 'ready'
  readonly caps: readonly string[]
  readonly features: readonly string[]
}
export interface ActuatorMemberUnread {
  readonly kind: 'unreadable'
  readonly error: string
}
export type ActuatorMemberLookup = ActuatorMemberReady | ActuatorMemberUnread

export function isActuatorGroupDevice(device: object): device is ActuatorGroupDevice {
  return 'syncShared' in device && 'recordCommands' in device && 'id' in device
}

export interface ActuatorGroupDevice {
  readonly id: number
  syncShared(caps: readonly string[], modes: readonly DeviceFeature[]): void
  recordCommands(results: readonly GroupCommandResult[]): void
}

export interface ActuatorBlock {
  readonly id: string
  /** Group helpers are remembered; an appliance helper is not a command group. */
  readonly helper: HelperSpec | undefined
}

export interface ActuatorGroupsDeps {
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly resolve: (
    ref: CompositionSourceRef,
  ) => { readonly kind: 'found'; readonly deviceId: number } | { readonly kind: 'other' }
  readonly readMember: (deviceId: number) => Promise<ActuatorMemberLookup>
  readonly deviceOf: (blockId: string) => ActuatorGroupDevice | null
  readonly invoke: (call: FanOutCall) => Promise<void>
}

interface RememberedGroup {
  readonly blockId: string
  readonly templateId: ActuatorTemplateId
  readonly groupDeviceId: number
  readonly members: readonly HelperMember[]
  readonly fanOut: readonly FanOutMember[]
  readonly shared: readonly string[]
  readonly methods: readonly ActuatorMethodRow[]
}

interface ViewedMembers {
  readonly fanOut: readonly FanOutMember[]
  /** Null when any member could not be read — optional caps stay off. */
  readonly capLists: readonly (readonly string[])[] | null
  readonly featureLists: readonly (readonly string[])[]
}

export class ActuatorGroups {
  private groups: ReadonlyMap<string, RememberedGroup> = new Map()
  private readonly bound: (input: ActuatorDispatchInput) => Promise<void>

  constructor(private readonly deps: ActuatorGroupsDeps) {
    this.bound = (input) => this.command(input)
    setActuatorDispatcher(this.bound)
  }

  shutdown(): void {
    setActuatorDispatcher(null)
  }

  async sync(blocks: readonly ActuatorBlock[]): Promise<void> {
    const next = new Map<string, RememberedGroup>()
    for (const block of blocks) {
      const remembered = await this.remember(block)
      if (remembered !== null) next.set(block.id, remembered)
    }
    this.groups = next
  }

  async onMemberBindings(deviceId: number): Promise<void> {
    const hit = [...this.groups.values()].filter((group) =>
      group.fanOut.some((member) => member.deviceId === deviceId),
    )
    if (hit.length === 0) return
    const next = new Map(this.groups)
    for (const group of hit) {
      const block: ActuatorBlock = {
        id: group.blockId,
        helper: {
          kind: 'group',
          templateId: group.templateId,
          aggregate: 'any',
          active: 'at-least-one',
          members: group.members.map(copyMember),
        },
      }
      const remembered = await this.remember(block)
      if (remembered !== null) next.set(group.blockId, remembered)
    }
    this.groups = next
  }

  private async remember(block: ActuatorBlock): Promise<RememberedGroup | null> {
    const spec = block.helper
    if (spec === undefined || spec.kind !== 'group') return null
    const template = groupTemplate(spec.templateId)
    if (template === null || template.family !== 'actuator') return null
    const templateId = actuatorTemplateId(template.id)
    if (templateId === null) return null
    const device = this.deps.deviceOf(block.id)
    if (device === null) return null
    const viewed = await this.viewMembers(spec.members, device.id)
    const methods = methodsOf(templateId, viewed)
    const shared = capsOf(methods)
    const previous = this.groups.get(block.id)?.shared
    if (previous !== undefined) this.logCapChange(templateId, device.id, previous, shared, viewed)
    const modes =
      templateId === 'light' && shared.includes('color')
        ? sharedColorModes(viewed.featureLists)
        : sharedActuatorFeatures(templateId, viewed.featureLists)
    device.syncShared(shared, modes)
    return {
      blockId: block.id,
      templateId,
      groupDeviceId: device.id,
      members: spec.members.map(copyMember),
      fanOut: viewed.fanOut,
      shared,
      methods,
    }
  }

  private async viewMembers(
    members: readonly HelperMember[],
    groupDeviceId: number,
  ): Promise<ViewedMembers> {
    const fanOut: FanOutMember[] = []
    const capLists: (readonly string[])[] = []
    const featureLists: (readonly string[])[] = []
    let complete = true
    for (const member of members) {
      const resolved = this.deps.resolve(member.source)
      if (resolved.kind !== 'found') {
        complete = false
        this.deps.logger.warn(
          'actuator group left a member out of shared commands — its device was not resolved',
          {
            tags: { deviceId: groupDeviceId },
            meta: { source: `${member.source.addonId}/${member.source.stableId}` },
          },
        )
        continue
      }
      const read = await this.deps.readMember(resolved.deviceId)
      if (read.kind !== 'ready') {
        complete = false
        fanOut.push({ deviceId: resolved.deviceId, caps: [], online: true })
        this.deps.logger.warn(
          'actuator group left a member out of shared commands — its capabilities could not be read',
          {
            tags: { deviceId: resolved.deviceId },
            meta: { groupDeviceId, error: read.error },
          },
        )
        continue
      }
      capLists.push(read.caps)
      featureLists.push(read.features)
      fanOut.push({ deviceId: resolved.deviceId, caps: read.caps, online: true })
    }
    return { fanOut, capLists: complete ? capLists : null, featureLists }
  }

  private logCapChange(
    templateId: ActuatorTemplateId,
    groupDeviceId: number,
    previous: readonly string[],
    shared: readonly string[],
    viewed: ViewedMembers,
  ): void {
    const primary = ACTUATOR_METHODS[templateId][0]?.cap
    const optional = [
      ...new Set(
        ACTUATOR_METHODS[templateId].map((row) => row.cap).filter((cap) => cap !== primary),
      ),
    ]
    for (const cap of optional) {
      const had = previous.includes(cap)
      const has = shared.includes(cap)
      if (had === has) continue
      if (has) {
        this.deps.logger.info(`${templateId} group gained a shared capability`, {
          tags: { deviceId: groupDeviceId },
          meta: { cap },
        })
        continue
      }
      this.deps.logger.warn(`${templateId} group dropped a capability a member does not bind`, {
        tags: { deviceId: groupDeviceId },
        meta: { cap },
      })
      for (const member of viewed.fanOut) {
        if (member.caps.includes(cap)) continue
        this.deps.logger.warn(
          `${templateId} group dropped a capability this member does not bind`,
          {
            tags: { deviceId: member.deviceId },
            meta: { groupDeviceId, cap },
          },
        )
      }
    }
  }

  private async command(input: ActuatorDispatchInput): Promise<void> {
    const group = [...this.groups.values()].find(
      (item) => item.groupDeviceId === input.groupDeviceId,
    )
    if (group === undefined) {
      this.deps.logger.warn('actuator command dropped — this device is not a live helper group', {
        tags: { deviceId: input.groupDeviceId },
        meta: { cap: input.cap, method: input.method },
      })
      throw new Error('actuator group is not live')
    }
    if (!group.shared.includes(input.cap)) {
      this.deps.logger.warn('actuator command dropped — the group does not share that capability', {
        tags: { deviceId: input.groupDeviceId },
        meta: { cap: input.cap, method: input.method },
      })
      throw new Error(`group does not share ${input.cap}`)
    }
    const row = group.methods.find((item) => item.cap === input.cap && item.method === input.method)
    if (row === undefined) {
      this.deps.logger.warn('actuator command dropped — the group does not share that method', {
        tags: { deviceId: input.groupDeviceId },
        meta: { cap: input.cap, method: input.method },
      })
      throw new Error(`group does not share ${input.cap}.${input.method}`)
    }
    const refusal = methodRefusal(row, input.args)
    if (refusal !== null) {
      this.deps.logger.warn(`${input.cap}.${input.method} was refused — nothing was sent`, {
        tags: { deviceId: input.groupDeviceId },
        meta: { cap: input.cap, method: input.method, reason: refusal },
      })
      throw new Error(refusal)
    }
    const calls = fanOutTargets(group.fanOut, input.cap, input.method, memberArgs(input.args))
    const results = await runFanOut(calls, (call) => this.deps.invoke(call))
    const failed = results.flatMap((result) => (result.ok ? [] : [result]))
    for (const result of failed) {
      this.deps.logger.warn(
        'actuator group command failed on a member — the others were still attempted',
        {
          tags: { deviceId: result.deviceId },
          meta: {
            groupDeviceId: input.groupDeviceId,
            cap: input.cap,
            method: input.method,
            error: result.error,
          },
        },
      )
    }
    if (failed.length > 0) {
      this.deps.logger.warn('actuator group command finished with member failures', {
        tags: { deviceId: input.groupDeviceId },
        meta: { failed: failed.length, attempted: results.length, cap: input.cap },
      })
    }
    const at = this.deps.now()
    const device = this.deps.deviceOf(group.blockId)
    device?.recordCommands(
      results.map((result) => ({
        deviceId: result.deviceId,
        cap: input.cap,
        method: input.method,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
        at,
      })),
    )
  }
}

function actuatorTemplateId(id: string): ActuatorTemplateId | null {
  return ACTUATOR_TEMPLATE_IDS.find((item) => item === id) ?? null
}

/**
 * Members that could not all be read leave only the type's own, ungated
 * methods on: a surface nobody confirmed is never offered.
 */
function methodsOf(
  templateId: ActuatorTemplateId,
  viewed: ViewedMembers,
): readonly ActuatorMethodRow[] {
  const rows = ACTUATOR_METHODS[templateId]
  const primary = rows[0]?.cap
  const own = rows.filter((row) => row.cap === primary && row.requires === null)
  if (viewed.capLists === null || viewed.capLists.length === 0) return own
  return sharedActuatorMethods(
    templateId,
    viewed.capLists.map((caps, index) => ({ caps, features: viewed.featureLists[index] ?? [] })),
  )
}

function capsOf(methods: readonly ActuatorMethodRow[]): readonly string[] {
  return [...new Set(methods.map((row) => row.cap))]
}

/** The confirmation is the group's to check; a member's own method does not know it. */
function memberArgs(args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'confirm'))
}

function copyMember(member: HelperMember): HelperMember {
  return {
    source: { addonId: member.source.addonId, stableId: member.source.stableId },
    cap: member.cap,
    fieldPath: member.fieldPath,
  }
}
