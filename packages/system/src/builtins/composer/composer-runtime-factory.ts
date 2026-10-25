/**
 * What a planned block's runtime is built from: WHERE it writes (its composed
 * device, or a claim-backed target on an existing device) and HOW it reads
 * (rule 6: a self-read of a field the block did not ADD is the native, never
 * the merge; the block's own output is answered by the runtime, never through
 * the hub — D670 amendment).
 */
import {
  type CapabilityLookup,
  composedDeviceRef,
  compositionSourceKey,
  type IScopedLogger,
} from '@camstack/types'
import type { ComposedDeviceHandle } from './composed-device.js'
import type { PlannedBlock } from './composer-plan.js'
import {
  type ComposedWriteTarget,
  type CompositionEventEmitter,
  CompositionRuntime,
  type DeadlineTimer,
} from './composition-runtime.js'
import {
  claimFieldsOf,
  claimModeOf,
  type ComposerClaimsApi,
  type ExistingTargetSeedRead,
  selfReadCaps,
} from './existing-target.js'
import type { ClaimEvent } from './held-claims.js'
import { OwnedFieldsTarget } from './owned-fields-target.js'
import type { PulseFieldSeed } from './pulse-seed.js'
import type { SourceTracker } from './source-tracker.js'

/** The composer dependencies a runtime and its write target are built from. */
export interface RuntimeFactoryDeps {
  readonly logger: IScopedLogger
  readonly claims: ComposerClaimsApi
  readonly tracker: SourceTracker
  readonly events: CompositionEventEmitter
  readonly lookupCap: CapabilityLookup
  readonly now: () => number
  readonly newTimer: () => DeadlineTimer
}

/** Where a block's own claim transitions are followed (C-1/N-1). */
export type ClaimEventSink = (
  deviceId: number,
  cap: string,
  owner: string,
  event: ClaimEvent,
) => void

/** Where a block's runtime writes: its composed device, or a claim-backed target on the existing device. */
export function writerFor(
  deps: RuntimeFactoryDeps,
  p: PlannedBlock,
  device: ComposedDeviceHandle | null,
  onClaimEvent: ClaimEventSink,
): ComposedWriteTarget | null {
  const target = p.target
  if (target.kind !== 'existing') return device
  if (target.deviceId === null || target.waiting !== null || target.gone !== null) return null
  const deviceId = target.deviceId
  const owner = p.block.id
  return new OwnedFieldsTarget({
    deviceId,
    owner,
    modeOf: (cap) => claimModeOf(target.features, cap),
    fieldsOf: (cap) => claimFieldsOf(p.fields, cap),
    api: deps.claims,
    logger: deps.logger.child('owned'),
    onClaim: (cap, event) => onClaimEvent(deviceId, cap, owner, event),
  })
}

export function newCompositionRuntime(
  deps: RuntimeFactoryDeps,
  p: PlannedBlock,
  target: ComposedWriteTarget,
  seed?: ExistingTargetSeedRead,
  pulseSeeds?: ReadonlyMap<string, PulseFieldSeed>,
): CompositionRuntime {
  const self =
    p.target.kind === 'existing' ? selfReadCaps(p.fields, p.target.ref, p.target.features) : null
  const targetKey = p.target.kind === 'existing' ? compositionSourceKey(p.target.ref) : null
  const nativeCaps = new Set(self?.native ?? [])
  // The block's OWN output: an added cap on its target, or its composed
  // device. Answered by the runtime, never through the hub (D670 amendment).
  const ownKey = targetKey ?? compositionSourceKey(composedDeviceRef(p.block.id))
  return new CompositionRuntime({
    blockId: p.block.id,
    fields: p.fields,
    eventPlans: p.events,
    events: deps.events,
    target,
    lookupCap: deps.lookupCap,
    ...(seed === undefined ? {} : { initialByCap: seed.byCap }),
    ...(pulseSeeds === undefined ? {} : { pulseSeeds }),
    // Rule 6: a self-read of a field the block did not ADD is the native, never the merge.
    read: (read) =>
      deps.tracker.read(
        read,
        compositionSourceKey(read.source) === targetKey && nativeCaps.has(read.cap)
          ? 'native'
          : 'effective',
      ),
    isOwnRead: (read) => compositionSourceKey(read.source) === ownKey && !nativeCaps.has(read.cap),
    now: deps.now,
    timer: deps.newTimer(),
    logger: deps.logger.child('runtime'),
  })
}
