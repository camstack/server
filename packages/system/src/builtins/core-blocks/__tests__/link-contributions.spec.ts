/**
 * Identity links (D1063): the Customize features a `linked` link contributes,
 * stamped `contributedBy`, and taken back when the link goes.
 */
import {
  compositionSourceKey,
  coreBlockComposition,
  type Composition,
  type CompositionFeature,
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  type CoreBlock,
  type IdentityLink,
  type IdentityLinksRead,
  type IScopedLogger,
} from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import { CompositionChangedError, IDENTITY_LINKS_USER_ID } from '../composition-api.js'
import { LinkContributionReconciler, MAX_HOST_ATTEMPTS } from '../link-contributions.js'

const PORT = { addonId: 'provider-unifi', stableId: 'port-7', deviceId: 10 }
const CAMERA = { addonId: 'provider-hikvision', stableId: 'cam-1', deviceId: 20 }
const CAMERA_REF: CompositionSourceRef = { addonId: CAMERA.addonId, stableId: CAMERA.stableId }
const LINK_ID = 'poe-power:provider-unifi/port-7|provider-hikvision/cam-1'

function link(state: IdentityLink['state'] = 'linked'): IdentityLink {
  return {
    id: LINK_ID,
    kind: 'poe-power',
    a: PORT,
    b: CAMERA,
    state,
    origin: 'auto',
    evidence: [{ key: 'mac', value: 'aa:bb:cc:dd:ee:ff' }],
    createdAt: 1,
  }
}

function block(id: string, composition: Composition, updatedAt = 1, createdBy = 'u'): CoreBlock {
  return {
    id,
    name: `Custom ${id}`,
    code: '',
    enabled: true,
    createdAt: 1,
    updatedAt,
    createdBy,
    status: 'stopped',
    lastChangedAt: 1,
    source: { kind: 'composition', composition },
  }
}

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

interface World {
  readonly reconciler: LinkContributionReconciler
  readonly blocks: CoreBlock[]
  readonly writes: () => number
  readonly removed: readonly string[]
  readonly log: IScopedLogger
  setLinks(read: IdentityLinksRead): void
}

function world(
  options: {
    readonly bound?: readonly string[]
    readonly blocks?: CoreBlock[]
    /** How many updates throw stale before one lands: Infinity = always. */
    readonly staleUpdates?: number
  } = {},
): World {
  let staleLeft = options.staleUpdates ?? 0
  const blocks: CoreBlock[] = options.blocks ?? []
  let links: IdentityLinksRead = { status: 'answered', links: [link()] }
  let writes = 0
  let nextId = 100
  const removed: string[] = []
  const log = logger()
  const reconciler = new LinkContributionReconciler({
    listLinks: async () => links,
    deviceIdOf: async (ref) =>
      compositionSourceKey(ref) === compositionSourceKey(CAMERA_REF) ? CAMERA.deviceId : null,
    boundCaps: async () => options.bound ?? [],
    blocks: () => blocks,
    create: async (host, features) => {
      writes += 1
      blocks.push(
        block(
          `b${nextId++}`,
          {
            target: { kind: 'existing', device: host },
            features: [...features],
          },
          1,
          IDENTITY_LINKS_USER_ID,
        ),
      )
    },
    update: async (stored, composition) => {
      writes += 1
      if (staleLeft > 0) {
        staleLeft -= 1
        throw new CompositionChangedError(
          stored.id,
          stored.name,
          stored.updatedAt + 1,
          stored.updatedAt,
        )
      }
      const i = blocks.findIndex((b) => b.id === stored.id)
      blocks[i] = block(stored.id, composition, stored.updatedAt + 1, stored.createdBy)
    },
    remove: async (stored) => {
      removed.push(stored.id)
      const i = blocks.findIndex((b) => b.id === stored.id)
      if (i >= 0) blocks.splice(i, 1)
    },
    logger: log,
  })
  return {
    reconciler,
    log,
    blocks,
    writes: () => writes,
    removed,
    setLinks: (read) => {
      links = read
    },
  }
}

function hostFeatures(blocks: readonly CoreBlock[]): readonly CompositionFeature[] {
  for (const b of blocks) {
    const c = coreBlockComposition(b)
    if (
      c?.target.kind === 'existing' &&
      compositionSourceKey(c.target.device) === compositionSourceKey(CAMERA_REF)
    ) {
      return c.features
    }
  }
  return []
}

function stamped(features: readonly CompositionFeature[]): readonly CompositionFieldsFeature[] {
  return features.flatMap((f) => (f.kind === 'fields' && f.contributedBy !== undefined ? [f] : []))
}

const OPERATOR_FEATURE: CompositionFieldsFeature = {
  kind: 'fields',
  cap: 'power-source',
  fields: {
    switchOn: {
      kind: 'from',
      source: { addonId: 'provider-shelly', stableId: 'plug-1' },
      cap: 'switch',
      fieldPath: 'on',
    },
  },
}

describe('LinkContributionReconciler', () => {
  it('a linked poe-power link writes exactly one stamped power-source feature, sourced from the port', async () => {
    const w = world()
    await w.reconciler.pass()
    await w.reconciler.pass()
    const features = stamped(hostFeatures(w.blocks))
    expect(features).toHaveLength(1)
    expect(features[0]).toMatchObject({
      cap: 'power-source',
      contributedBy: { linkId: LINK_ID },
      fields: {
        switchOn: {
          kind: 'from',
          source: { addonId: PORT.addonId, stableId: PORT.stableId },
          cap: 'switch',
          fieldPath: 'on',
        },
      },
    })
    expect(w.writes()).toBe(1)
  })

  it('a proposed link contributes nothing', async () => {
    const w = world()
    w.setLinks({ status: 'answered', links: [link('proposed')] })
    await w.reconciler.pass()
    expect(w.blocks).toEqual([])
  })

  it('a host serving power-source natively is skipped (D944)', async () => {
    const w = world({ bound: ['power-source'] })
    await w.reconciler.pass()
    expect(w.blocks).toEqual([])
  })

  it('an unstamped operator feature wins: the link writes nothing over it', async () => {
    const w = world({
      blocks: [
        block('op', {
          target: { kind: 'existing', device: CAMERA_REF },
          features: [OPERATOR_FEATURE],
        }),
      ],
    })
    await w.reconciler.pass()
    expect(hostFeatures(w.blocks)).toEqual([OPERATOR_FEATURE])
    expect(w.writes()).toBe(0)
    expect(w.log.info).toHaveBeenCalledWith(
      expect.stringContaining('the operator already set this target'),
      expect.objectContaining({ tags: { deviceId: CAMERA.deviceId } }),
    )
  })

  it('the operator turning the feature off survives a reconcile', async () => {
    const w = world()
    await w.reconciler.pass()
    const b = w.blocks[0]
    const c = b === undefined ? null : coreBlockComposition(b)
    if (b === undefined || c === null) throw new Error('expected a block')
    w.blocks[0] = block(b.id, {
      ...c,
      features: c.features.map((f) => (f.kind === 'fields' ? { ...f, enabled: false } : f)),
    })
    await w.reconciler.pass()
    expect(stamped(hostFeatures(w.blocks))[0]?.enabled).toBe(false)
  })

  it("a lost link takes back only its stamped feature; the operator's features stay", async () => {
    const other: CompositionFieldsFeature = { ...OPERATOR_FEATURE, cap: 'battery' }
    const w = world({
      blocks: [
        block('op', { target: { kind: 'existing', device: CAMERA_REF }, features: [other] }),
      ],
    })
    await w.reconciler.pass()
    expect(stamped(hostFeatures(w.blocks))).toHaveLength(1)
    w.setLinks({ status: 'answered', links: [] })
    await w.reconciler.pass()
    expect(hostFeatures(w.blocks)).toEqual([other])
  })

  it('withdrawing the last contribution deletes the block the reconciler created: no empty block, no stamp left', async () => {
    const w = world()
    await w.reconciler.pass()
    expect(w.blocks).toHaveLength(1)
    w.setLinks({ status: 'answered', links: [] })
    await w.reconciler.pass()
    expect(w.removed).toHaveLength(1)
    expect(w.blocks).toEqual([])
    expect(JSON.stringify(w.blocks)).not.toContain(LINK_ID)
    await w.reconciler.pass()
    expect(w.removed).toHaveLength(1)
  })

  it('a block the reconciler created that an operator edit left with their feature stays', async () => {
    const other: CompositionFieldsFeature = { ...OPERATOR_FEATURE, cap: 'battery' }
    const w = world()
    await w.reconciler.pass()
    const b = w.blocks[0]
    const c = b === undefined ? null : coreBlockComposition(b)
    if (b === undefined || c === null) throw new Error('expected a block')
    w.blocks[0] = block(b.id, { ...c, features: [...c.features, other] }, 2, IDENTITY_LINKS_USER_ID)
    w.setLinks({ status: 'answered', links: [] })
    await w.reconciler.pass()
    expect(w.removed).toEqual([])
    expect(hostFeatures(w.blocks)).toEqual([other])
  })

  it('a block the operator added a feature to after the snapshot was read is not deleted', async () => {
    const other: CompositionFieldsFeature = { ...OPERATOR_FEATURE, cap: 'battery' }
    const w = world()
    await w.reconciler.pass()
    w.setLinks({ status: 'answered', links: [] })
    // The operator's write lands between the pass's read and its delete.
    vi.mocked(w.log.info).mockImplementationOnce(() => {
      const b = w.blocks[0]
      const c = b === undefined ? null : coreBlockComposition(b)
      if (b === undefined || c === null) return
      w.blocks[0] = block(b.id, { ...c, features: [other] }, 9, IDENTITY_LINKS_USER_ID)
    })
    await w.reconciler.pass()
    expect(w.removed).toEqual([])
    expect(hostFeatures(w.blocks)).toEqual([other])
  })

  it('an empty block the reconciler left earlier is cleaned on the next pass', async () => {
    const w = world({
      blocks: [
        block(
          'stale',
          { target: { kind: 'existing', device: CAMERA_REF }, features: [] },
          1,
          IDENTITY_LINKS_USER_ID,
        ),
      ],
    })
    w.setLinks({ status: 'answered', links: [] })
    await w.reconciler.pass()
    expect(w.removed).toEqual(['stale'])
  })

  it('links not yet read change nothing (D315)', async () => {
    const w = world()
    await w.reconciler.pass()
    w.setLinks({ status: 'not-loaded', reason: 'boot' })
    await w.reconciler.pass()
    expect(stamped(hostFeatures(w.blocks))).toHaveLength(1)
    expect(w.reconciler.hasAnswered()).toBe(true)
  })
  it('a stale write is retried against a fresh read and lands', async () => {
    const w = world({
      staleUpdates: 1,
      blocks: [
        block('op', {
          target: { kind: 'existing', device: CAMERA_REF },
          features: [{ ...OPERATOR_FEATURE, cap: 'battery' }],
        }),
      ],
    })
    await w.reconciler.pass()
    expect(stamped(hostFeatures(w.blocks))).toHaveLength(1)
    expect(w.writes()).toBe(2)
    expect(w.log.warn).not.toHaveBeenCalled()
  })

  it(`a block that is stale every time is tried ${MAX_HOST_ATTEMPTS} times, then a warn line tagged with the host`, async () => {
    const w = world({
      staleUpdates: Number.POSITIVE_INFINITY,
      blocks: [
        block('op', {
          target: { kind: 'existing', device: CAMERA_REF },
          features: [{ ...OPERATOR_FEATURE, cap: 'battery' }],
        }),
      ],
    })
    await w.reconciler.pass()
    expect(w.writes()).toBe(MAX_HOST_ATTEMPTS)
    expect(w.log.warn).toHaveBeenCalledTimes(1)
    expect(w.log.warn).toHaveBeenCalledWith(
      expect.stringContaining(`changed under ${MAX_HOST_ATTEMPTS} writes`),
      expect.objectContaining({ tags: { deviceId: CAMERA.deviceId } }),
    )
  })

  it('an operator-confirmed link whose evidence is gone is not owed: its stamp goes and the fresh port contributes', async () => {
    // Operator confirmed port 7 → camera A; A then moved to port 9, camera B took port 7.
    const port9 = { addonId: PORT.addonId, stableId: 'port-9', deviceId: 11 }
    const cameraB = { addonId: CAMERA.addonId, stableId: 'cam-2', deviceId: 21 }
    const confirmed: IdentityLink = { ...link(), origin: 'operator' }
    const w = world()
    w.setLinks({ status: 'answered', links: [confirmed] })
    await w.reconciler.pass()
    expect(stamped(hostFeatures(w.blocks))[0]?.contributedBy).toEqual({ linkId: LINK_ID })

    const movedId = 'poe-power:provider-unifi/port-9|provider-hikvision/cam-1'
    const takenId = 'poe-power:provider-unifi/port-7|provider-hikvision/cam-2'
    w.setLinks({
      status: 'answered',
      links: [
        { ...confirmed, evidenceGone: true },
        { ...link(), id: movedId, a: port9 },
        { ...link(), id: takenId, b: cameraB },
      ],
    })
    await w.reconciler.pass()
    const onA = stamped(hostFeatures(w.blocks))
    expect(onA).toHaveLength(1)
    expect(onA[0]?.contributedBy).toEqual({ linkId: movedId })
    expect(onA[0]?.fields['switchOn']).toMatchObject({
      source: { addonId: PORT.addonId, stableId: 'port-9' },
    })
    expect(w.log.info).not.toHaveBeenCalledWith(
      expect.stringContaining('another link'),
      expect.anything(),
    )
  })

  it.each([
    ['dismissed, still listed', [link('dismissed')]],
    ['deleted', []],
  ] as const)('a withdrawal whose link is %s names the host by its device id, never -1', async (_label, after) => {
    const w = world()
    await w.reconciler.pass()
    w.setLinks({ status: 'answered', links: after })
    await w.reconciler.pass()
    expect(stamped(hostFeatures(w.blocks))).toHaveLength(0)
    expect(w.log.info).toHaveBeenCalledWith(
      expect.stringContaining('withdrawn'),
      expect.objectContaining({ tags: { deviceId: CAMERA.deviceId } }),
    )
  })
})
