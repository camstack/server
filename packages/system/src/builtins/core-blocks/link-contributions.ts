/**
 * The Customize features an identity link contributes (D1063).
 *
 * A `linked` link adds, on its host device, each default contribution its kind
 * declares (`IDENTITY_LINK_KINDS[kind].contributions`) — a PoE port's link adds
 * `power-source` to the camera it feeds, sourced from the port's `switch.on`.
 * The feature is an ordinary D663 customization feature stamped
 * `contributedBy: { linkId }`; its `enabled` toggle is the operator's (D62) and
 * survives every pass. A link that is no longer `linked` takes back only the
 * features it stamped.
 *
 * Skipped, with a line in the host's log:
 *  - the host serves the cap natively (D944) — the link never replaces it;
 *  - the operator already set that target with no stamp — the operator wins;
 *  - another link already stamped that cap on the host.
 *
 * Runs on `identity-link.created` / `.lost`, after boot, and for every pass it
 * asks for it reads the links itself (event plus RPC reconcile, D11). Coalesced
 * and serialized; no timer. Links that are `not-loaded` change nothing (D315).
 */
import {
  IDENTITY_LINK_KINDS,
  compileScalarOverride,
  compositionSourceKey,
  coreBlockComposition,
  errMsg,
  mergeScalarTarget,
  removeScalarTarget,
  type Composition,
  type CompositionFeature,
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  type CoreBlock,
  type IdentityLink,
  type IdentityLinkContribution,
  type IdentityLinksRead,
  type IScopedLogger,
} from '@camstack/types'

/** What the reconciler reads and writes; the addon wires these to `ctx.api` and the composition API. */
export interface LinkContributionPorts {
  readonly listLinks: () => Promise<IdentityLinksRead>
  /** The caps bound on a device right now (`getBindings`). */
  readonly boundCaps: (deviceId: number) => Promise<readonly string[]>
  /** Every stored block; `null` until the table was read. */
  readonly blocks: () => readonly CoreBlock[] | null
  readonly create: (
    host: CompositionSourceRef,
    features: readonly CompositionFeature[],
  ) => Promise<void>
  readonly update: (block: CoreBlock, composition: Composition) => Promise<void>
  readonly logger: IScopedLogger
}

/** One contribution a linked link owes its host. */
interface Owed {
  readonly link: IdentityLink
  readonly contribution: IdentityLinkContribution
  readonly hostDeviceId: number
  readonly source: CompositionSourceRef
}

interface HostPlan {
  readonly host: CompositionSourceRef
  readonly hostDeviceId: number
  readonly owed: Owed[]
}

function refOf(side: IdentityLink['a']): CompositionSourceRef {
  return { addonId: side.addonId, stableId: side.stableId }
}

function fieldsFeature(feature: CompositionFeature): CompositionFieldsFeature | null {
  return feature.kind === 'fields' ? feature : null
}

/** Compile one contribution as the Customize editor would, then stamp it. */
export function compileContribution(
  owed: Owed,
  host: CompositionSourceRef,
): CompositionFieldsFeature | null {
  const out = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: owed.contribution.cap,
      targetId: owed.contribution.targetId,
      source: {
        ...owed.source,
        cap: owed.contribution.sourceCap,
        fieldPath: owed.contribution.sourceField,
      },
      transform: { kind: 'identity' },
    },
    device: host,
    apply: 'add',
    sourceValueKind: 'boolean',
    changedAtField: null,
    sourceUnit: null,
  })
  if (!out.ok) return null
  return { ...out.value, contributedBy: { linkId: owed.link.id } }
}

export class LinkContributionReconciler {
  private tail: Promise<unknown> = Promise.resolve()
  private passQueued = false
  private answered = false

  constructor(private readonly ports: LinkContributionPorts) {}

  /** True once a pass has read the links — until then a device registration asks again. */
  hasAnswered(): boolean {
    return this.answered
  }

  requestPass(): void {
    if (this.passQueued) return
    this.passQueued = true
    void this.serialized(async () => {
      this.passQueued = false
      await this.pass()
    }).catch((err: unknown) => {
      this.ports.logger.warn(
        'identity-link contributions: pass failed — the next link event retries',
        {
          meta: { error: errMsg(err) },
        },
      )
    })
  }

  async settled(): Promise<void> {
    await this.serialized(async () => undefined)
  }

  async pass(): Promise<void> {
    const read = await this.ports.listLinks()
    const blocks = this.ports.blocks()
    if (read.status !== 'answered' || blocks === null) return
    this.answered = true
    const plans = new Map<string, HostPlan>()
    for (const link of read.links) {
      if (link.state !== 'linked') continue
      for (const contribution of IDENTITY_LINK_KINDS[link.kind].contributions) {
        const hostSide = link[contribution.host]
        const host = refOf(hostSide)
        const key = compositionSourceKey(host)
        const plan = plans.get(key) ?? { host, hostDeviceId: hostSide.deviceId, owed: [] }
        plan.owed.push({
          link,
          contribution,
          hostDeviceId: hostSide.deviceId,
          source: refOf(link[contribution.source]),
        })
        plans.set(key, plan)
      }
    }
    // A host with a stamped feature and no owed contribution is visited too: its stamps go.
    for (const block of blocks) {
      const composition = coreBlockComposition(block)
      if (composition === null || composition.target.kind !== 'existing') continue
      const stamped = composition.features.some(
        (f) => fieldsFeature(f)?.contributedBy !== undefined,
      )
      const key = compositionSourceKey(composition.target.device)
      if (stamped && !plans.has(key)) {
        plans.set(key, { host: composition.target.device, hostDeviceId: -1, owed: [] })
      }
    }
    for (const plan of plans.values()) {
      try {
        await this.reconcileHost(plan, blocks)
      } catch (err: unknown) {
        this.ports.logger.warn('identity-link contributions: host not reconciled', {
          ...(plan.hostDeviceId >= 0 ? { tags: { deviceId: plan.hostDeviceId } } : {}),
          meta: { host: compositionSourceKey(plan.host), error: errMsg(err) },
        })
      }
    }
  }

  private async reconcileHost(plan: HostPlan, blocks: readonly CoreBlock[]): Promise<void> {
    const key = compositionSourceKey(plan.host)
    const block =
      blocks.find((b) => {
        const c = coreBlockComposition(b)
        return (
          c !== null &&
          c.target.kind === 'existing' &&
          compositionSourceKey(c.target.device) === key
        )
      }) ?? null
    const composition = block === null ? null : coreBlockComposition(block)
    const before = composition?.features ?? []
    const owedIds = new Set(plan.owed.map((o) => o.link.id))
    // 1. Take back every stamp whose link no longer owes it.
    let features: CompositionFeature[] = []
    for (const feature of before) {
      const fields = fieldsFeature(feature)
      const stamp = fields?.contributedBy
      if (fields === null || stamp === undefined || owedIds.has(stamp.linkId)) {
        features.push(feature)
        continue
      }
      const kept = removeScalarTarget(fields, fields.cap, this.targetIdOfStamp(fields))
      if (kept !== null) features.push(kept)
      this.ports.logger.info('identity-link contribution withdrawn — its link is gone', {
        ...(plan.hostDeviceId >= 0 ? { tags: { deviceId: plan.hostDeviceId } } : {}),
        meta: { cap: fields.cap, linkId: stamp.linkId, host: key },
      })
    }
    // 2. Add or refresh what each linked link owes.
    let bound: readonly string[] | null = null
    for (const owed of plan.owed) {
      const cap = owed.contribution.cap
      const index = features.findIndex((f) => fieldsFeature(f)?.cap === cap)
      const found = index < 0 ? undefined : features[index]
      const current = found === undefined ? null : fieldsFeature(found)
      const compiled = compileContribution(owed, plan.host)
      if (compiled === null) {
        this.skip(owed, 'the contribution does not compile against the Customize catalog')
        continue
      }
      if (current === null) {
        bound ??= await this.ports.boundCaps(plan.hostDeviceId)
        if (bound.includes(cap)) {
          this.skip(owed, 'the device serves this capability natively (D944)')
          continue
        }
        features = [...features, compiled]
        this.log('identity-link contribution added', owed)
        continue
      }
      const stamp = current.contributedBy
      if (stamp === undefined) {
        this.skip(owed, 'the operator already set this target in Customize')
        continue
      }
      if (stamp.linkId !== owed.link.id) {
        this.skip(owed, `another link (${stamp.linkId}) already contributes this capability`)
        continue
      }
      const merged = mergeScalarTarget(current, compiled, cap, owed.contribution.targetId)
      // The operator's toggle is theirs (D62): a refresh never flips it.
      const refreshed: CompositionFieldsFeature =
        current.enabled === undefined ? merged : { ...merged, enabled: current.enabled }
      if (JSON.stringify(refreshed) === JSON.stringify(current)) continue
      features = features.map((f, i) => (i === index ? refreshed : f))
      this.log('identity-link contribution refreshed', owed)
    }
    if (JSON.stringify(features) === JSON.stringify(before)) return
    if (block === null || composition === null) {
      await this.ports.create(plan.host, features)
      return
    }
    await this.ports.update(block, { ...composition, features })
  }

  /** The target a stamped feature carries: the kind table names it. */
  private targetIdOfStamp(feature: CompositionFieldsFeature): string {
    for (const spec of Object.values(IDENTITY_LINK_KINDS)) {
      const hit = spec.contributions.find((c) => c.cap === feature.cap)
      if (hit !== undefined) return hit.targetId
    }
    return ''
  }

  private skip(owed: Owed, reason: string): void {
    this.ports.logger.info(`identity-link contribution skipped — ${reason}`, {
      tags: { deviceId: owed.hostDeviceId },
      meta: { cap: owed.contribution.cap, linkId: owed.link.id },
    })
  }

  private log(message: string, owed: Owed): void {
    this.ports.logger.info(message, {
      tags: { deviceId: owed.hostDeviceId },
      meta: { cap: owed.contribution.cap, linkId: owed.link.id },
    })
  }

  private serialized<T>(write: () => Promise<T>): Promise<T> {
    const run = this.tail.then(write, write)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
