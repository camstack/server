/**
 * The composition half of the `core-blocks` provider (D659). Flat methods,
 * spread into the provider: no nested sub-object.
 *
 * Every save is VALIDATED against the live sources, its existing target (read
 * once: slim row + `getBindings`) and every stored composition first; a refusal
 * names each problem by path and reason (D391) and stores nothing. The store's
 * own refusals (not loaded, unknown block, a code block) propagate unchanged —
 * this layer never swallows them.
 *
 * A customization of an existing device (D663) has no name of its own: the
 * server derives it (`customizationBlockName`), refuses one the client sends,
 * and never lets it move to another device. One per device, by block id (S2).
 *
 * A feature an identity link contributed (`contributedBy`, D1063) is switched
 * off by the operator, never removed: an update that drops one is refused as
 * `link-contribution-removed`, except the identity-link reconciler's own write
 * (`linkReconcilerCaller()`), which is how a contribution is withdrawn. Every
 * other write of a customization asks for a link pass (`compositionWritten`).
 */
import {
  type CapabilityDefinition,
  type CapabilityLookup,
  type Composition,
  type CompositionBlockInput,
  type CompositionBlockPatch,
  type CompositionBlockState,
  type CompositionFieldRead,
  type CompositionFieldsFeature,
  type CompositionSourceDescription,
  type CompositionSourceRef,
  type CompositionStateRead,
  type CompositionValidation,
  type CompositionView,
  type CoreBlock,
  composedDeviceRef,
  compositionSourceKey,
  compositionSourceRefs,
  compositionUnionReads,
  helperMembers,
  coreBlockComposition,
  describeComposableCaps,
  errMsg,
  type ICoreBlocksProvider,
  type IScopedLogger,
  type UnreleasedClaim,
  problemsBlockSave,
  validateComposition,
} from '@camstack/types'
import { customizationBlockName } from '@camstack/types/node'
import type { NamedCompositionInput } from './core-block-store.js'
import { storedCustomizationTargets, storedPeers } from './composition-peers.js'
import type { CompositionDescriptions } from './composition-sources.js'
import { proposeForDevice, type RunningProposalPorts } from './running-proposal.js'

export interface CompositionStoreView {
  /** False until the table has been READ; a verdict against an empty peer set would hide a cycle. */
  isLoaded(): boolean
  list(): readonly CoreBlock[]
  get(blockId: string): CoreBlock | null
  createComposition(input: NamedCompositionInput, createdBy: string): Promise<CoreBlock>
  updateComposition(blockId: string, patch: CompositionBlockPatch): Promise<CoreBlock>
}

/** The `caller.userId` of the identity-link reconciler's own writes (D1063). */
export const IDENTITY_LINKS_USER_ID = 'identity-links'

/** Who wrote a composition. */
export interface CompositionWriter {
  readonly userId: string
}

/** The caller the identity-link reconciler writes as. */
export interface LinkReconcilerCaller extends CompositionWriter {
  readonly isAdmin: boolean
}

/**
 * The reconciler's callers, by object identity. The gate is this set, never the
 * `userId` string: a `caller` that arrived over the wire (a forked addon's
 * `ctx.api` args reach the provider as sent) is a different object, whatever it
 * names, so it can never pass as the reconciler.
 */
const LINK_RECONCILER_CALLERS = new WeakSet<CompositionWriter>()

/** A caller that IS the identity-link reconciler — mint it in-process only. */
export function linkReconcilerCaller(): LinkReconcilerCaller {
  const caller: LinkReconcilerCaller = {
    userId: IDENTITY_LINKS_USER_ID,
    isAdmin: true,
  }
  LINK_RECONCILER_CALLERS.add(caller)
  return caller
}

function isLinkReconciler(writer: CompositionWriter | undefined): boolean {
  return writer !== undefined && LINK_RECONCILER_CALLERS.has(writer)
}

/** An update named an `updatedAt` the stored block no longer has: reload and re-apply. */
export class CompositionChangedError extends Error {
  readonly blockId: string

  constructor(blockId: string, name: string, storedUpdatedAt: number, expectedUpdatedAt: number) {
    super(
      `core-blocks: the composition "${name}" changed since you read it: stored updatedAt ${storedUpdatedAt}, yours ${expectedUpdatedAt} — reload and re-apply your edit`,
    )
    this.name = 'CompositionChangedError'
    this.blockId = blockId
  }
}

/** The features of a composition an identity link contributed. */
export function linkContributedFeatures(
  composition: Composition | null,
): readonly CompositionFieldsFeature[] {
  return (composition?.features ?? []).flatMap((f) =>
    f.kind === 'fields' && f.contributedBy !== undefined ? [f] : [],
  )
}

/**
 * Why a block cannot be deleted: it holds features identity links contributed
 * (`link-contribution-removed`, D1063). Null when it can.
 */
export function linkContributionDeleteRefusal(block: CoreBlock | null): string | null {
  const stamped = linkContributedFeatures(block === null ? null : coreBlockComposition(block))
  if (stamped.length === 0) return null
  const named = stamped.map((f) => `${f.cap} (device link ${f.contributedBy?.linkId ?? ''})`)
  return `core-blocks: "${block?.name ?? ''}" was not deleted [link-contribution-removed] — ${named.join(', ')} added by a device link; switch it off instead, or unlink the device to take it away`
}

export interface CompositionApiDeps {
  readonly store: CompositionStoreView
  /** One read of every source and every existing target a save names (`describeCompositionSources`). */
  readonly describe: (
    sources: readonly CompositionSourceRef[],
    targets: readonly CompositionSourceRef[],
    unionReads?: readonly CompositionFieldRead[],
  ) => Promise<CompositionDescriptions>
  readonly lookupCap: CapabilityLookup
  readonly composerStates: (
    blockIds: readonly string[],
  ) => Promise<readonly CompositionBlockState[]>
  readonly convergeSoon: () => void
  /**
   * One composer apply, awaited. An edit that replaces caps does not return
   * until the caps it dropped have been released, or the release has failed
   * and is in the list.
   */
  readonly convergeForClaims: () => Promise<readonly UnreleasedClaim[]>
  /** The history reads behind `proposeRunningThreshold`. */
  readonly runningProposal: RunningProposalPorts
  readonly logger: IScopedLogger
  /**
   * After an operator renames a composed device's block, write that name onto
   * the device row (stamped). Absent in tests that predate it: the block save
   * still lands, and the composer retries the device write on its next apply.
   */
  readonly writeComposedDeviceName?: (blockId: string, name: string) => Promise<void>
  /**
   * The device manager owns a composed device's name (D1057); the block's stored
   * name is a mirror. Reads show the row's name, by block id. A read that fails
   * shows the mirror. Absent in tests that predate it.
   */
  readonly readComposedDeviceNames?: () => Promise<ReadonlyMap<string, string>>
  /** Every capability definition — the listing is derived from them, never from the registry's live state. */
  readonly capabilityDefinitions: readonly CapabilityDefinition[]
  /**
   * A customization of an existing device was written by someone other than the
   * identity-link reconciler: its contributions are reconciled (D1063). Absent in
   * specs that predate it.
   */
  readonly compositionWritten?: (target: CompositionSourceRef, writer: CompositionWriter) => void
}

export type CompositionApi = Pick<
  ICoreBlocksProvider,
  | 'createComposition'
  | 'updateComposition'
  | 'getComposition'
  | 'listCompositions'
  | 'validateComposition'
  | 'getCustomization'
  | 'listComposableCaps'
  | 'proposeRunningThreshold'
>

const NOT_LOADED_REASON = 'core_blocks has not loaded yet'

/** What a refusal names: the block's name, and its id once it has one. */
interface RefusalSubject {
  readonly name: string
  readonly blockId: string | null
}

/** Runs one write at a time — see {@link buildCompositionApi}. */
type WriteQueue = <T>(write: () => Promise<T>) => Promise<T>

function writeQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(write: () => Promise<T>): Promise<T> => {
    const run = tail.then(write, write)
    // The queue carries ORDER, not outcome: a refused write never blocks the next.
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/**
 * Optimistic concurrency: an update names the `updatedAt` it read. A block
 * changed since is refused by name — last-write-wins would drop the other
 * admin's edit without a word. An unknown block falls through to the store,
 * whose own refusal names it.
 */
function refuseIfChanged(
  deps: CompositionApiDeps,
  blockId: string,
  expectedUpdatedAt: number,
): void {
  const stored = deps.store.get(blockId)
  if (stored === null || stored.updatedAt === expectedUpdatedAt) return
  deps.logger.warn('composition update refused: changed since read', {
    meta: { blockId, storedUpdatedAt: stored.updatedAt, expectedUpdatedAt },
  })
  throw new CompositionChangedError(blockId, stored.name, stored.updatedAt, expectedUpdatedAt)
}

/**
 * An update that drops a link-contributed feature is refused (D1063): the
 * operator's off-switch is `enabled: false`. The reconciler's own write is how a
 * contribution is withdrawn, so it passes.
 */
function refuseLinkContributionRemoval(
  deps: CompositionApiDeps,
  blockId: string,
  next: Composition | undefined,
  writer: CompositionWriter | undefined,
): void {
  if (next === undefined || isLinkReconciler(writer)) return
  const stored = deps.store.get(blockId)
  if (stored === null) return
  const kept = new Set(next.features.map((f) => f.cap))
  const removed = linkContributedFeatures(coreBlockComposition(stored)).filter(
    (f) => !kept.has(f.cap),
  )
  if (removed.length === 0) return
  refuse(
    deps,
    { name: stored.name, blockId },
    {
      ok: false,
      problems: removed.map((f) => ({
        code: 'link-contribution-removed',
        path: `features.${f.cap}`,
        message: `${f.cap} was added by the device link ${f.contributedBy?.linkId ?? ''} — switch it off instead; unlink the device to take it away`,
      })),
      fields: [],
      features: [],
      events: [],
    },
    [],
  )
}

/**
 * The reconciler taking back what it stamped, and nothing else (D1063): the
 * composition is unchanged apart from its features (target and helper
 * included), every stored feature the operator wrote survives verbatim, and
 * every other kept feature is a stored one or an unstamped remainder of a
 * stamped one — a subset of its fields, with the same values. Removing features
 * cannot create a conflict, and a withdrawal must land on a customization whose
 * host was removed — which the store judge refuses as `target-missing` — so it
 * is not judged.
 */
function isStampWithdrawal(
  stored: Composition | null,
  next: Composition,
  writer: CompositionWriter | undefined,
): boolean {
  if (!isLinkReconciler(writer) || stored === null) return false
  if (JSON.stringify({ ...stored, features: [] }) !== JSON.stringify({ ...next, features: [] })) {
    return false
  }
  const stamped = linkContributedFeatures(stored)
  if (stamped.length === 0) return false
  const storedKeys = new Set(stored.features.map((f) => JSON.stringify(f)))
  const nextKeys = new Set(next.features.map((f) => JSON.stringify(f)))
  const operatorKept = stored.features.every(
    (f) =>
      (f.kind === 'fields' && f.contributedBy !== undefined) || nextKeys.has(JSON.stringify(f)),
  )
  const nothingAdded = next.features.every(
    (f) =>
      storedKeys.has(JSON.stringify(f)) ||
      (f.kind === 'fields' &&
        f.contributedBy === undefined &&
        stamped.some((from) => isRemainderOf(f, from))),
  )
  return operatorKept && nothingAdded && next.features.length <= stored.features.length
}

/** `kept` is `stamped` without its stamp, cut down to some of its fields, each unchanged. */
function isRemainderOf(kept: CompositionFieldsFeature, stamped: CompositionFieldsFeature): boolean {
  const { contributedBy: _stamp, fields: stampedFields, ...stampedRest } = stamped
  const { fields: keptFields, ...keptRest } = kept
  if (JSON.stringify(keptRest) !== JSON.stringify(stampedRest)) return false
  return Object.entries(keptFields).every(
    ([path, value]) =>
      Object.hasOwn(stampedFields, path) &&
      JSON.stringify(stampedFields[path]) === JSON.stringify(value),
  )
}

function noteWritten(
  deps: CompositionApiDeps,
  composition: Composition | null,
  writer: CompositionWriter | undefined,
): void {
  if (composition === null || composition.target.kind !== 'existing') return
  if (writer === undefined || isLinkReconciler(writer)) return
  deps.compositionWritten?.(composition.target.device, writer)
}

/** The device a composition writes, when it is an EXISTING one; null for a new device. */
function existingTarget(composition: Composition): CompositionSourceRef | null {
  return composition.target.kind === 'existing' ? composition.target.device : null
}

interface JudgedSave {
  readonly validation: CompositionValidation
  readonly memberDeviceIds: readonly number[]
}

function helperMemberDeviceIds(
  composition: Composition,
  sources: ReadonlyMap<string, CompositionSourceDescription>,
): readonly number[] {
  const helper = composition.helper
  if (helper === undefined) return []
  const ids: number[] = []
  for (const member of helperMembers(helper)) {
    const found = sources.get(compositionSourceKey(member.source))
    if (found?.kind === 'found') ids.push(found.deviceId)
  }
  return ids
}

async function validateAgainstStore(
  deps: CompositionApiDeps,
  composition: Composition,
  blockId: string | null,
): Promise<JudgedSave> {
  if (!deps.store.isLoaded()) {
    throw new Error(
      `${NOT_LOADED_REASON} — a composition cannot be judged against the stored ones until it has; retry shortly`,
    )
  }
  const self = blockId === null ? null : composedDeviceRef(blockId)
  const target = existingTarget(composition)
  // Reads of the device the candidate writes are its own (native or composed): never described as sources.
  const ownKeys = new Set(
    [self, target].flatMap((ref) => (ref === null ? [] : [compositionSourceKey(ref)])),
  )
  const refs = compositionSourceRefs(composition).filter(
    (r) => !ownKeys.has(compositionSourceKey(r)),
  )
  const blocks = deps.store.list()
  const read = await deps.describe(
    refs,
    [...(target === null ? [] : [target]), ...storedCustomizationTargets(blocks)],
    compositionUnionReads(composition, deps.lookupCap),
  )
  const stored = storedPeers(blocks, read.targets, deps.lookupCap, blockId)
  const validation = validateComposition(composition, {
    lookupCap: deps.lookupCap,
    sources: read.sources,
    self,
    blockId,
    // A target with no description is refused by `planComposition` as unread.
    target:
      target === null
        ? null
        : (read.targets.get(compositionSourceKey(target)) ?? {
            kind: 'unreadable',
            error: 'it was not read',
          }),
    peers: stored.peers,
    unreadTargets: stored.unread,
  })
  return {
    validation,
    memberDeviceIds: helperMemberDeviceIds(composition, read.sources),
  }
}

function describeProblems(validation: CompositionValidation): readonly string[] {
  return validation.problems.map((p) => `${p.path} [${p.code}]: ${p.message}`)
}

function refuse(
  deps: CompositionApiDeps,
  subject: RefusalSubject,
  validation: CompositionValidation,
  memberDeviceIds: readonly number[],
): never {
  const problems = describeProblems(validation)
  const meta = { name: subject.name, blockId: subject.blockId, problems }
  if (memberDeviceIds.length === 0) {
    deps.logger.warn('composition save refused', { meta })
  } else {
    for (const deviceId of memberDeviceIds) {
      deps.logger.warn('composition save refused', {
        tags: { deviceId },
        meta,
      })
    }
  }
  throw new Error(
    `core-blocks: the composition "${subject.name}" was refused — ${problems.join('; ')}`,
  )
}

async function readStates(
  deps: CompositionApiDeps,
  blockIds: readonly string[],
): Promise<ReadonlyMap<string, CompositionStateRead>> {
  try {
    const states = await deps.composerStates(blockIds)
    const byId = new Map(states.map((s) => [s.blockId, s]))
    return new Map(
      blockIds.map((id): [string, CompositionStateRead] => [
        id,
        { kind: 'answered', state: byId.get(id) ?? null },
      ]),
    )
  } catch (err: unknown) {
    const error = errMsg(err)
    deps.logger.warn('composer state unreachable', {
      meta: { blocks: blockIds.length, error },
    })
    return new Map(
      blockIds.map((id): [string, CompositionStateRead] => [id, { kind: 'unreachable', error }]),
    )
  }
}

/**
 * One block's composer state. A block the answer leaves out is UNREACHABLE,
 * never folded into "no composition" (D315, M-4).
 */
async function readState(deps: CompositionApiDeps, blockId: string): Promise<CompositionStateRead> {
  const state = (await readStates(deps, [blockId])).get(blockId)
  return (
    state ?? {
      kind: 'unreachable',
      error: 'the composer state read returned no entry for the block',
    }
  )
}

function toViews(
  blocks: readonly CoreBlock[],
  states: ReadonlyMap<string, CompositionStateRead>,
): CompositionView[] {
  return blocks.flatMap((block) => {
    const state = states.get(block.id)
    return state === undefined ? [] : [{ block, state }]
  })
}

const NO_NAME_OF_ITS_OWN =
  "a customization has no name of its own — the device's name is shown; omit `name`"
const NEW_DEVICE_NEEDS_NAME = 'a new device needs a name'
const DEVICE_IS_FIXED =
  "a customization's device cannot be changed — delete it and customize the other device"
const NEVER_BECOMES_CUSTOMIZATION =
  'a composed device cannot become the customization of another device — create the customization instead'

/** What a refusal line can say about the device a save targets: its number, or why not. */
type TargetResolution =
  | { readonly kind: 'device'; readonly deviceId: number }
  | { readonly kind: 'unresolved'; readonly why: string }

/**
 * The numeric id of a save's existing target, for the refusal line's tag
 * (D391: a line about a device carries `tags.deviceId`). Read only on a
 * refusal — one listing — and a failed read names itself on the line instead.
 */
async function resolveTarget(
  deps: CompositionApiDeps,
  target: CompositionSourceRef,
): Promise<TargetResolution> {
  try {
    const found = (await deps.describe([], [target])).targets.get(compositionSourceKey(target))
    if (found?.kind === 'found') return { kind: 'device', deviceId: found.deviceId }
    return { kind: 'unresolved', why: found?.kind ?? 'not described' }
  } catch (err: unknown) {
    return { kind: 'unresolved', why: errMsg(err) }
  }
}

/** A save refused before validation, by name (D391): logged, then thrown. */
async function refuseSave(
  deps: CompositionApiDeps,
  subject: RefusalSubject,
  target: CompositionSourceRef | null,
  reason: string,
): Promise<never> {
  const resolved = target === null ? null : await resolveTarget(deps, target)
  deps.logger.warn('composition save refused', {
    ...(resolved?.kind === 'device' ? { tags: { deviceId: resolved.deviceId } } : {}),
    meta: {
      name: subject.name,
      blockId: subject.blockId,
      target: target === null ? null : compositionSourceKey(target),
      ...(resolved?.kind === 'unresolved' ? { targetUnresolved: resolved.why } : {}),
      reason,
    },
  })
  throw new Error(`core-blocks: the composition "${subject.name}" was refused — ${reason}`)
}

/**
 * The name a new block is stored under (rule 1): a new device's own, required;
 * a customization's DERIVED from its device (ruling S2), never the client's.
 */
async function nameOnCreate(
  deps: CompositionApiDeps,
  block: CompositionBlockInput,
): Promise<string> {
  const target = existingTarget(block.composition)
  if (target === null) {
    if (block.name === undefined)
      return refuseSave(deps, { name: '(unnamed)', blockId: null }, null, NEW_DEVICE_NEEDS_NAME)
    return block.name
  }
  if (block.name !== undefined)
    return refuseSave(deps, { name: block.name, blockId: null }, target, NO_NAME_OF_ITS_OWN)
  return customizationBlockName(target)
}

/**
 * A customization is pinned to its device and carries no client name (rule 2);
 * a composed device never turns into one — its name would be the client's. An
 * unknown or code block falls through to the store, whose refusal names it.
 */
async function refuseRetarget(
  deps: CompositionApiDeps,
  blockId: string,
  patch: CompositionBlockPatch,
): Promise<void> {
  const stored = deps.store.get(blockId)
  const current = stored === null ? null : coreBlockComposition(stored)
  if (stored === null || current === null) return
  const subject: RefusalSubject = { name: stored.name, blockId }
  const pinned = existingTarget(current)
  const next = patch.composition === undefined ? pinned : existingTarget(patch.composition)
  if (pinned === null) {
    if (next !== null) return refuseSave(deps, subject, next, NEVER_BECOMES_CUSTOMIZATION)
    return
  }
  if (patch.name !== undefined) return refuseSave(deps, subject, pinned, NO_NAME_OF_ITS_OWN)
  if (next === null || compositionSourceKey(next) !== compositionSourceKey(pinned))
    return refuseSave(deps, subject, pinned, DEVICE_IS_FIXED)
}

/**
 * An editor rename of a composed device (not a customization, not a create)
 * writes the device name after the block has been saved. A failed device
 * write is logged and does not fail the save.
 */
async function followComposedRename(
  deps: CompositionApiDeps,
  previous: CoreBlock | null,
  name: string | undefined,
): Promise<void> {
  const write = deps.writeComposedDeviceName
  if (write === undefined || previous === null || name === undefined) return
  const [shown] = await withDeviceNames(deps, [previous])
  if (name === (shown?.name ?? previous.name)) return
  const composition = coreBlockComposition(previous)
  if (composition === null || existingTarget(composition) !== null) return
  try {
    await write(previous.id, name)
  } catch (err: unknown) {
    deps.logger.warn(
      'composed block was renamed but the device name was not written — retried on the next apply',
      { meta: { blockId: previous.id, error: errMsg(err) } },
    )
  }
}

/**
 * The blocks as the operator sees them: a composed device's name is the device
 * row's, whatever the mirror stored (one name, never two). A customization has
 * no name of its own and is returned as stored.
 */
async function withDeviceNames(
  deps: CompositionApiDeps,
  blocks: readonly CoreBlock[],
): Promise<readonly CoreBlock[]> {
  const read = deps.readComposedDeviceNames
  if (read === undefined || blocks.length === 0) return blocks
  let names: ReadonlyMap<string, string>
  try {
    names = await read()
  } catch (err: unknown) {
    deps.logger.warn('composed device names could not be read — the stored block names are shown', {
      meta: { error: errMsg(err) },
    })
    return blocks
  }
  return blocks.map((block) => {
    const name = names.get(block.id)
    return name === undefined || name === block.name ? block : { ...block, name }
  })
}

/** The block customizing `device`, found by TARGET — never by its derived name (rule 4). */
function customizationOf(
  blocks: readonly CoreBlock[],
  device: CompositionSourceRef,
): CoreBlock | null {
  const key = compositionSourceKey(device)
  return (
    blocks.find((block) => {
      const composition = coreBlockComposition(block)
      const target = composition === null ? null : existingTarget(composition)
      return target !== null && compositionSourceKey(target) === key
    }) ?? null
  )
}

/**
 * Every write runs validate-then-persist on ONE chain. Validation awaits a
 * source read before the save lands; two unserialized saves (A reads B, B
 * reads A) would each be judged against a store without the other and BOTH
 * pass — a stored cycle nothing downstream catches.
 */
export function buildCompositionApi(deps: CompositionApiDeps): CompositionApi {
  const serialized = writeQueue()
  return {
    proposeRunningThreshold: (input) => proposeForDevice(deps.runningProposal, input),

    createComposition: ({ block, caller }) =>
      serialized(async () => {
        const name = await nameOnCreate(deps, block)
        const judged = await validateAgainstStore(deps, block.composition, null)
        if (!judged.validation.ok && problemsBlockSave(judged.validation.problems)) {
          refuse(deps, { name, blockId: null }, judged.validation, judged.memberDeviceIds)
        }
        const created = await deps.store.createComposition({ ...block, name }, caller.userId)
        deps.logger.info('composition created', {
          meta: { blockId: created.id, name: created.name, by: caller.userId },
        })
        noteWritten(deps, block.composition, caller)
        deps.convergeSoon()
        return { block: created }
      }),

    updateComposition: ({ blockId, expectedUpdatedAt, block, caller }) =>
      serialized(async () => {
        refuseIfChanged(deps, blockId, expectedUpdatedAt)
        refuseLinkContributionRemoval(deps, blockId, block.composition, caller)
        await refuseRetarget(deps, blockId, block)
        const previous = deps.store.get(blockId)
        const withdrawal =
          block.composition !== undefined &&
          isStampWithdrawal(
            previous === null ? null : coreBlockComposition(previous),
            block.composition,
            caller,
          )
        if (block.composition !== undefined && !withdrawal) {
          const judged = await validateAgainstStore(deps, block.composition, blockId)
          if (!judged.validation.ok && problemsBlockSave(judged.validation.problems)) {
            refuse(
              deps,
              { name: block.name ?? blockId, blockId },
              judged.validation,
              judged.memberDeviceIds,
            )
          }
        }
        const stored = await deps.store.updateComposition(blockId, block)
        await followComposedRename(deps, previous, block.name)
        const [updated = stored] = await withDeviceNames(deps, [stored])
        deps.logger.info('composition updated', {
          meta: { blockId, by: caller?.userId ?? 'system' },
        })
        noteWritten(deps, coreBlockComposition(updated), caller)
        if (block.composition !== undefined) {
          const unreleased = (await deps.convergeForClaims()).filter(
            (claim) => claim.owner === blockId,
          )
          if (unreleased.length > 0) {
            for (const claim of unreleased) {
              deps.logger.error('composition saved but a replaced claim was not released', {
                tags: { deviceId: claim.deviceId },
                meta: { blockId, cap: claim.capName, error: claim.error },
              })
            }
            const detail = unreleased
              .map((claim) => `${claim.capName} on device ${claim.deviceId}: ${claim.error}`)
              .join('; ')
            throw new Error(
              `core-blocks: "${blockId}" was saved but a replaced claim was not released — ${detail}`,
            )
          }
        } else {
          deps.convergeSoon()
        }
        return { block: updated }
      }),

    getComposition: async ({ blockId }) => {
      if (!deps.store.isLoaded()) return { state: 'not-loaded', reason: NOT_LOADED_REASON }
      const block = deps.store.get(blockId)
      if (block === null || coreBlockComposition(block) === null) {
        return { state: 'loaded', view: null }
      }
      const [shown = block] = await withDeviceNames(deps, [block])
      return {
        state: 'loaded',
        view: { block: shown, state: await readState(deps, blockId) },
      }
    },

    listCompositions: async () => {
      if (!deps.store.isLoaded()) return { state: 'not-loaded', reason: NOT_LOADED_REASON }
      const stored = deps.store.list().filter((b) => coreBlockComposition(b) !== null)
      if (stored.length === 0) return { state: 'loaded', views: [] }
      const blocks = await withDeviceNames(deps, stored)
      const states = await readStates(
        deps,
        blocks.map((b) => b.id),
      )
      return { state: 'loaded', views: toViews(blocks, states) }
    },

    getCustomization: async ({ addonId, stableId }) => {
      if (!deps.store.isLoaded()) return { state: 'not-loaded', reason: NOT_LOADED_REASON }
      const block = customizationOf(deps.store.list(), { addonId, stableId })
      if (block === null) return { state: 'loaded', view: null }
      return {
        state: 'loaded',
        view: { block, state: await readState(deps, block.id) },
      }
    },

    validateComposition: async ({ composition, blockId }) =>
      (await validateAgainstStore(deps, composition, blockId ?? null)).validation,

    listComposableCaps: async ({ deviceType }) => ({
      caps: [...describeComposableCaps(deps.capabilityDefinitions, deviceType)],
    }),
  }
}
