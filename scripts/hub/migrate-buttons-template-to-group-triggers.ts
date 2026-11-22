#!/usr/bin/env tsx
/**
 * One-shot operator script: turn each "Buttons → devices" automation (the
 * retired builtin template) into the group triggers that replace it.
 *
 *   npx tsx scripts/hub/migrate-buttons-template-to-group-triggers.ts --server <host>             # preview
 *   npx tsx scripts/hub/migrate-buttons-template-to-group-triggers.ts --server <host> --apply     # create + disable the old
 *   npx tsx scripts/hub/migrate-buttons-template-to-group-triggers.ts --server <host> --finalize  # delete the old
 *   (optional) --token-file <f>
 *
 * Preview is the default and writes nothing. An instance converts only when each
 * button runs ONE switch command (on / off / toggle) on the SAME single device,
 * with no time window and nothing else around it; anything else is named and the
 * run changes nothing. The group is built with `output: 'none'` (no new device:
 * the triggers command the target directly), so the press does what it did.
 *
 * `--apply` creates the group (found again by its trigger fingerprint on a
 * re-run, never created twice), reads back that the automation it owns is
 * running, and only then DISABLES the old automation. The operator presses the
 * buttons and checks the trace; `--finalize` then deletes the disabled one.
 * Through `scripts/hub/hub.mjs` only; run on the dev hub first, backup first.
 */
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { z } from 'zod'
import {
  type AutomationRecipe,
  type CompositionSourceRef,
  type CoreBlock,
  type GroupHelperSpec,
  type GroupTrigger,
  CoreBlockSchema,
  DeviceType,
  compileHelper,
  coreBlockComposition,
  readRecipeLiteral,
} from '../../packages/types/src/index.js'
import { type HubCall, hubMjsCall } from './hub-call.js'

export const BUTTONS_TEMPLATE_ID = 'builtin:buttons-to-devices'

/** The switch commands a trigger can replace, and the group action each becomes. */
const ACTION_OF: Readonly<Record<string, GroupTrigger['action']>> = {
  'switch.on': { kind: 'on' },
  'switch.off': { kind: 'off' },
  'switch.toggle': { kind: 'switch' },
}
const STEP_KEYS: ReadonlySet<string> = new Set(['kind', 'target', 'actionId'])

/** What a device id resolves to: its stable reference and whether it is a light. */
export interface DeviceRef {
  readonly ref: CompositionSourceRef
  readonly isLight: boolean
}
export type DeviceLookup = (deviceId: number) => DeviceRef | null

export type ConversionPlan =
  | {
      readonly ok: true
      readonly blockId: string
      readonly oldName: string
      readonly groupName: string
      readonly spec: GroupHelperSpec
      readonly fingerprint: string
    }
  | {
      readonly ok: false
      readonly blockId: string
      readonly oldName: string
      readonly reason: string
    }

/** Same members and same triggers (ids and labels left out), whoever wrote them. */
export function specFingerprint(spec: GroupHelperSpec): string {
  const members = spec.members.map((m) => `${m.source.addonId}/${m.source.stableId}`).sort()
  const triggers = (spec.triggers ?? [])
    .map((t) => JSON.stringify({ source: t.source, action: t.action }))
    .sort()
  return createHash('sha256')
    .update(JSON.stringify({ members, triggers }))
    .digest('hex')
    .slice(0, 16)
}

function refuse(blockId: string, oldName: string, reason: string): ConversionPlan {
  return { ok: false, blockId, oldName, reason }
}

function idOfLeaf(sourceIds: readonly string[] | undefined, index: number): string {
  const only = sourceIds?.length === 1 ? sourceIds[0] : undefined
  const slug = only === undefined ? '' : only.toLowerCase().replace(/[^a-z0-9]/g, '')
  return slug === '' ? `t-${index + 1}` : `t-ch${slug}`
}

export function planConversion(
  blockId: string,
  oldName: string,
  recipe: AutomationRecipe,
  lookup: DeviceLookup,
): ConversionPlan {
  const no = (reason: string): ConversionPlan => refuse(blockId, oldName, reason)
  const when = recipe.when
  if (when.kind !== 'any') return no('it has a time window around the buttons')
  const [only, ...rest] = recipe.actions
  if (only === undefined || rest.length > 0 || only.kind !== 'choose' || only.else !== undefined) {
    return no('its actions are not one choice per button')
  }
  const leaves = new Map<
    string,
    Extract<(typeof when.children)[number], { kind: 'device-fired' }>
  >()
  for (const child of when.children) {
    if (child.kind !== 'device-fired' || child.id === undefined) {
      return no('a trigger is not a button press with an id')
    }
    leaves.set(child.id, child)
  }
  let target: number | null = null
  const triggers: GroupTrigger[] = []
  for (const branch of only.branches) {
    if (branch.if.kind !== 'triggered-by') return no('a branch is not guarded by its button')
    if (branch.steps.length !== 1) return no('a button runs more than one step, or none')
    const [step] = branch.steps
    if (step === undefined || step.kind !== 'command') return no('a step is not a device command')
    const action = ACTION_OF[step.actionId]
    if (action === undefined) return no(`the command ${step.actionId} is not on, off or toggle`)
    if (Object.keys(step).some((key) => !STEP_KEYS.has(key))) {
      return no('a step carries a guard, a continue-on-error or an argument')
    }
    if (step.target.kind !== 'devices' || step.target.ids.length !== 1) {
      return no('a step does not command exactly one device')
    }
    const [id] = step.target.ids
    if (id === undefined || (target !== null && target !== id)) {
      return no('the buttons command different devices')
    }
    target = id
    for (const leafId of branch.if.leafIds) {
      const leaf = leaves.get(leafId)
      if (leaf === undefined) return no(`a branch names the button ${leafId}, which does not exist`)
      const device = lookup(leaf.deviceId)
      if (device === null) return no(`the button device ${leaf.deviceId} is not in the registry`)
      triggers.push({
        id: idOfLeaf(leaf.sourceIds, triggers.length),
        source: {
          kind: 'fired',
          device: device.ref,
          ...(leaf.eventIds === undefined ? {} : { eventIds: leaf.eventIds }),
          ...(leaf.sourceIds === undefined ? {} : { sourceIds: leaf.sourceIds }),
          ...(leaf.kinds === undefined ? {} : { kinds: leaf.kinds }),
          ...(leaf.match === undefined ? {} : { match: leaf.match }),
        },
        action,
      })
    }
  }
  if (target === null || triggers.length === 0) return no('it has no button to convert')
  const device = lookup(target)
  if (device === null) return no(`the target device ${target} is not in the registry`)
  const ids = new Set(triggers.map((t) => t.id))
  if (ids.size !== triggers.length) return no('two buttons would get the same trigger id')
  const spec: GroupHelperSpec = {
    kind: 'group',
    templateId: device.isLight ? 'light' : 'switch',
    aggregate: 'any',
    active: 'at-least-one',
    output: 'none',
    members: [{ source: device.ref, cap: 'switch', fieldPath: 'on' }],
    triggers,
  }
  const compiled = compileHelper(spec)
  if (!compiled.ok) {
    return no(`the group did not compile: ${compiled.problems.map((p) => p.message).join('; ')}`)
  }
  return {
    ok: true,
    blockId,
    oldName,
    groupName: oldName,
    spec,
    fingerprint: specFingerprint(spec),
  }
}

export interface MigrationOptions {
  readonly apply: boolean
  readonly finalize: boolean
  readonly log: (line: string) => void
  /** Names the group; the operator may rename it afterwards. */
  readonly groupName?: (oldName: string) => string
}

export type MigrationOutcome =
  | { readonly status: 'blocked'; readonly reasons: readonly string[] }
  | { readonly status: 'done'; readonly instances: number; readonly changed: number }

type DeviceRow = z.infer<typeof DevicesAnswerSchema>[number]

function groupOf(blocks: readonly CoreBlock[], fingerprint: string): CoreBlock | null {
  return (
    blocks.find((block) => {
      const helper = coreBlockComposition(block)?.helper
      return helper?.kind === 'group' && specFingerprint(helper) === fingerprint
    }) ?? null
  )
}

function ownedRunning(blocks: readonly CoreBlock[], groupId: string): boolean {
  return blocks.some((block) => {
    const read = readRecipeLiteral(block.code)
    return (
      read.status === 'recipe' &&
      read.recipe.ownedBy?.blockId === groupId &&
      block.enabled &&
      block.status === 'running'
    )
  })
}

function instancesOf(
  blocks: readonly CoreBlock[],
): readonly { block: CoreBlock; recipe: AutomationRecipe }[] {
  return blocks.flatMap((block) => {
    const read = readRecipeLiteral(block.code)
    return read.status === 'recipe' && read.recipe.template?.templateId === BUTTONS_TEMPLATE_ID
      ? [{ block, recipe: read.recipe }]
      : []
  })
}

function deviceIdsOf(recipe: AutomationRecipe): readonly number[] {
  const ids: number[] = []
  if (recipe.when.kind === 'any') {
    for (const child of recipe.when.children)
      if (child.kind === 'device-fired') ids.push(child.deviceId)
  }
  for (const action of recipe.actions) {
    if (action.kind !== 'choose') continue
    for (const branch of action.branches) {
      for (const step of branch.steps) {
        if (step.kind === 'command' && step.target.kind === 'devices') ids.push(...step.target.ids)
      }
    }
  }
  return ids
}

const BlocksAnswerSchema = z.object({ blocks: z.array(CoreBlockSchema) })
const BlockAnswerSchema = z.object({ block: CoreBlockSchema })
const DevicesAnswerSchema = z.array(
  z.object({ id: z.number(), addonId: z.string(), stableId: z.string(), type: z.string() }),
)

async function readBlocks(call: HubCall): Promise<readonly CoreBlock[]> {
  return BlocksAnswerSchema.parse(await call.query('coreBlocks.list', {})).blocks
}

async function readDevices(
  call: HubCall,
  ids: readonly number[],
): Promise<ReadonlyMap<number, DeviceRow>> {
  if (ids.length === 0) return new Map()
  const rows = DevicesAnswerSchema.parse(
    await call.query('deviceManager.listAll', { deviceIds: [...new Set(ids)] }),
  )
  return new Map(rows.map((row) => [row.id, row]))
}

export async function migrateButtonsTemplate(
  call: HubCall,
  options: MigrationOptions,
): Promise<MigrationOutcome> {
  const { log } = options
  let blocks = await readBlocks(call)
  const instances = instancesOf(blocks)
  if (instances.length === 0) {
    log('no "Buttons → devices" automation left: nothing to migrate')
    return { status: 'done', instances: 0, changed: 0 }
  }
  const devices = await readDevices(
    call,
    instances.flatMap((item) => deviceIdsOf(item.recipe)),
  )
  const lookup: DeviceLookup = (id) => {
    const row = devices.get(id)
    return row === undefined
      ? null
      : {
          ref: { addonId: row.addonId, stableId: row.stableId },
          isLight: row.type === DeviceType.Light,
        }
  }
  const nameOf = options.groupName ?? ((old: string) => old)
  const plans = instances.map((item) =>
    planConversion(item.block.id, item.block.name, item.recipe, lookup),
  )
  const blocked = plans.flatMap((plan) =>
    plan.ok ? [] : [`${plan.blockId} "${plan.oldName}": NOT convertible — ${plan.reason}`],
  )
  if (blocked.length > 0) {
    for (const line of blocked) log(line)
    return { status: 'blocked', reasons: blocked }
  }
  let changed = 0
  for (const plan of plans) {
    if (!plan.ok) continue
    const existing = groupOf(blocks, plan.fingerprint)
    const triggerLine = (plan.spec.triggers ?? []).map((t) => `${t.id}→${t.action.kind}`).join(', ')
    log(
      `${plan.blockId} "${plan.oldName}" → group "${nameOf(plan.groupName)}" (${plan.spec.templateId}, no device, member ${plan.spec.members[0]?.source.stableId}; ${triggerLine})${existing === null ? '' : ` [group ${existing.id} already exists]`}`,
    )
    if (options.finalize) {
      if (existing === null || !ownedRunning(blocks, existing.id)) {
        log(`  refused: the group is not running its automation, the old one stays`)
        continue
      }
      await call.mutate('coreBlocks.delete', { blockId: plan.blockId })
      log('  deleted the old automation')
      changed += 1
      continue
    }
    if (!options.apply) continue
    let group = existing
    if (group === null) {
      const compiled = compileHelper(plan.spec)
      if (!compiled.ok) continue
      const created = BlockAnswerSchema.parse(
        await call.mutate('coreBlocks.createComposition', {
          block: { name: nameOf(plan.groupName), enabled: true, composition: compiled.composition },
        }),
      )
      group = created.block
      log(`  created the group ${group.id}`)
      changed += 1
    }
    blocks = await readBlocks(call)
    if (!ownedRunning(blocks, group.id)) {
      log('  the group automation is not running yet: the old one stays enabled, run --apply again')
      continue
    }
    const old = blocks.find((block) => block.id === plan.blockId)
    if (old?.enabled === true) {
      await call.mutate('coreBlocks.setEnabled', { blockId: plan.blockId, enabled: false })
      log('  disabled the old automation: press the buttons, check the trace, then --finalize')
      changed += 1
    }
  }
  return { status: 'done', instances: instances.length, changed }
}

interface Args {
  readonly server: string
  readonly tokenFile: string | null
  readonly apply: boolean
  readonly finalize: boolean
  readonly groupName: string | null
}

function parseArgs(argv: readonly string[]): Args | string {
  const take = (name: string): string | null => {
    const at = argv.indexOf(name)
    return at === -1 ? null : (argv[at + 1] ?? null)
  }
  const server = take('--server')
  if (server === null)
    return 'usage: --server <host> [--token-file <f>] [--apply | --finalize] [--group-name <name>]'
  const apply = argv.includes('--apply')
  const finalize = argv.includes('--finalize')
  if (apply && finalize) return '--apply and --finalize are separate runs'
  return {
    server,
    tokenFile: take('--token-file'),
    apply,
    finalize,
    groupName: take('--group-name'),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args === 'string') {
    console.error(args)
    process.exit(2)
  }
  const mode = args.finalize ? 'FINALIZE' : args.apply ? 'APPLY' : 'PREVIEW (nothing is written)'
  console.log(mode)
  const outcome = await migrateButtonsTemplate(hubMjsCall(args.server, args.tokenFile), {
    apply: args.apply,
    finalize: args.finalize,
    ...(args.groupName === null ? {} : { groupName: () => args.groupName ?? '' }),
    log: (line) => console.log(line),
  })
  if (outcome.status === 'blocked') process.exit(1)
  console.log(`${outcome.instances} automation(s) seen, ${outcome.changed} change(s) made`)
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')
) {
  void main()
}
