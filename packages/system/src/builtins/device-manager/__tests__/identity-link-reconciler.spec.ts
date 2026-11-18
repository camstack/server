/**
 * Identity links (D1063): the reconciler turns the index's candidates into
 * `identity-links` rows, and the operator decides on proposals.
 */
import {
  DeviceRole,
  EventCategory,
  makeInMemoryRecords,
  type IdentityLinkEventPayload,
  type IScopedLogger,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { IdentityLinkCandidate, IdentityLinkCandidates } from '../device-identity-index.js'
import { IdentityLinkReconciler } from '../identity-link-reconciler.js'
import { IdentityLinksStore } from '../identity-links-store.js'
import { deviceManagerRecordKinds } from '../record-kinds.js'

const PORT = { addonId: 'provider-unifi', stableId: 'port-7', deviceId: 10 }
const CAMERA = { addonId: 'provider-hikvision', stableId: 'cam-1', deviceId: 20 }
const MAC = { key: 'mac' as const, value: 'aa:bb:cc:dd:ee:ff' }
const IP = { key: 'ip' as const, value: '10.0.0.7' }

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Emitted {
  readonly category: EventCategory
  readonly payload: IdentityLinkEventPayload
}

function candidate(confidence: 'auto' | 'proposal'): IdentityLinkCandidate {
  return {
    kind: 'poe-power',
    a: PORT,
    b: CAMERA,
    aRole: DeviceRole.PoePort,
    keys: confidence === 'auto' ? [IP, MAC] : [MAC],
    confidence,
  }
}

interface Rig {
  readonly reconciler: IdentityLinkReconciler
  readonly store: IdentityLinksStore
  readonly emitted: Emitted[]
  set(next: readonly IdentityLinkCandidate[]): void
  present: Set<number>
  readonly passes: () => number
}

async function rig(options: { readonly load?: boolean } = {}): Promise<Rig> {
  const { records } = makeInMemoryRecords('device-manager')
  await records.declare(deviceManagerRecordKinds)
  const store = IdentityLinksStore.of(records)
  if (options.load !== false) await store.load()
  const emitted: Emitted[] = []
  let current: readonly IdentityLinkCandidate[] = []
  const present = new Set<number>([PORT.deviceId, CAMERA.deviceId])
  const ids = new Map<string, number>([
    [`${PORT.addonId}/${PORT.stableId}`, PORT.deviceId],
    [`${CAMERA.addonId}/${CAMERA.stableId}`, CAMERA.deviceId],
  ])
  let passes = 0
  const candidates = (): IdentityLinkCandidates => {
    passes += 1
    return answered()
  }
  const answered = (): IdentityLinkCandidates => ({
    status: 'answered',
    candidates: current,
    deviceIdOf: (addonId, stableId) => {
      const id = ids.get(`${addonId}/${stableId}`)
      return id !== undefined && present.has(id) ? id : null
    },
  })
  const reconciler = new IdentityLinkReconciler({
    candidates,
    store,
    emit: (category, payload) => void emitted.push({ category, payload }),
    logger: silentLogger(),
    now: () => 1_000,
  })
  return {
    reconciler,
    store,
    emitted,
    passes: () => passes,
    present,
    set: (next) => {
      current = next
    },
  }
}

describe('IdentityLinkReconciler', () => {
  it('an auto candidate becomes a linked row and emits created once', async () => {
    const r = await rig()
    r.set([candidate('auto')])
    await r.reconciler.pass()
    await r.reconciler.pass()
    const links = r.store.list() ?? []
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ state: 'linked', origin: 'auto', kind: 'poe-power' })
    expect(r.emitted).toEqual([
      {
        category: EventCategory.IdentityLinkCreated,
        payload: expect.objectContaining({ aDeviceId: 10, bDeviceId: 20, origin: 'auto' }),
      },
    ])
  })

  it('a proposal candidate becomes a proposed row with no event', async () => {
    const r = await rig()
    r.set([candidate('proposal')])
    await r.reconciler.pass()
    expect(r.store.list()?.[0]?.state).toBe('proposed')
    expect(r.emitted).toEqual([])
  })

  it('a proposal that gains strong evidence is upgraded to linked', async () => {
    const r = await rig()
    r.set([candidate('proposal')])
    await r.reconciler.pass()
    r.set([candidate('auto')])
    await r.reconciler.pass()
    expect(r.store.list()?.[0]).toMatchObject({ state: 'linked', origin: 'auto' })
    expect(r.emitted.map((e) => e.category)).toEqual([EventCategory.IdentityLinkCreated])
  })

  it('a dismissed proposal is never re-proposed, not even on a fresh auto match', async () => {
    const r = await rig()
    r.set([candidate('proposal')])
    await r.reconciler.pass()
    const id = r.store.list()?.[0]?.id ?? ''
    expect((await r.reconciler.dismiss(id)).ok).toBe(true)
    r.set([candidate('auto')])
    await r.reconciler.pass()
    expect(r.store.list()?.[0]?.state).toBe('dismissed')
    expect(r.emitted).toEqual([])
  })

  it('a candidate whose attaching side is not a PoE port is skipped', async () => {
    const r = await rig()
    r.set([{ ...candidate('auto'), aRole: 'switch-light' }])
    await r.reconciler.pass()
    expect(r.store.list()).toEqual([])
  })

  it('an auto link whose evidence is gone is lost (a different client on the port)', async () => {
    const r = await rig()
    r.set([candidate('auto')])
    await r.reconciler.pass()
    r.set([])
    await r.reconciler.pass()
    expect(r.store.list()).toEqual([])
    expect(r.emitted.map((e) => [e.category, e.payload.reason])).toEqual([
      [EventCategory.IdentityLinkCreated, undefined],
      [EventCategory.IdentityLinkLost, 'evidence-gone'],
    ])
  })

  it('an operator link whose evidence is gone is kept and flagged, and unflagged when it returns', async () => {
    const r = await rig()
    r.set([candidate('proposal')])
    await r.reconciler.pass()
    const id = r.store.list()?.[0]?.id ?? ''
    await r.reconciler.confirm(id)
    r.set([])
    await r.reconciler.pass()
    expect(r.store.get(id)).toMatchObject({
      state: 'linked',
      origin: 'operator',
      evidenceGone: true,
    })
    r.set([candidate('proposal')])
    await r.reconciler.pass()
    expect(r.store.get(id)?.evidenceGone).toBeUndefined()
    expect(r.store.get(id)?.state).toBe('linked')
  })

  it('a side with no row is not evidence: the link stays until the removal step', async () => {
    const r = await rig()
    r.set([candidate('auto')])
    await r.reconciler.pass()
    r.present.delete(CAMERA.deviceId)
    r.set([])
    await r.reconciler.pass()
    expect(r.store.list()).toHaveLength(1)
  })

  it('removing either side deletes the row and emits lost/device-removed', async () => {
    const r = await rig()
    r.set([candidate('auto')])
    await r.reconciler.pass()
    expect(await r.reconciler.removeDevice(CAMERA.deviceId)).toBe(1)
    expect(r.store.list()).toEqual([])
    expect(r.emitted.at(-1)).toEqual({
      category: EventCategory.IdentityLinkLost,
      payload: expect.objectContaining({ reason: 'device-removed' }),
    })
  })

  it('unlink turns a linked row dismissed and emits lost/operator-unlinked', async () => {
    const r = await rig()
    r.set([candidate('auto')])
    await r.reconciler.pass()
    const id = r.store.list()?.[0]?.id ?? ''
    const answer = await r.reconciler.unlink(id)
    expect(answer.ok).toBe(true)
    expect(r.store.get(id)?.state).toBe('dismissed')
    expect(r.emitted.at(-1)?.payload.reason).toBe('operator-unlinked')
    await r.reconciler.pass()
    expect(r.store.get(id)?.state).toBe('dismissed')
  })

  it('a decision on the wrong state or an unknown link is refused by name', async () => {
    const r = await rig()
    r.set([candidate('auto')])
    await r.reconciler.pass()
    const id = r.store.list()?.[0]?.id ?? ''
    expect(await r.reconciler.confirm(id)).toMatchObject({ ok: false, reason: 'wrong-state' })
    expect(await r.reconciler.dismiss('nope')).toMatchObject({ ok: false, reason: 'unknown-link' })
  })

  it('an unread store answers not-loaded, never an empty list (D315)', async () => {
    const r = await rig({ load: false })
    expect(r.reconciler.list().status).toBe('not-loaded')
    expect(await r.reconciler.confirm('x')).toMatchObject({ ok: false, reason: 'not-loaded' })
  })

  it('list(deviceId) answers only the links naming that device', async () => {
    const r = await rig()
    r.set([candidate('auto')])
    await r.reconciler.pass()
    const mine = r.reconciler.list(CAMERA.deviceId)
    const other = r.reconciler.list(99)
    expect(mine.status === 'answered' ? mine.links.length : -1).toBe(1)
    expect(other.status === 'answered' ? other.links.length : -1).toBe(0)
  })

  it('requests while a pass is queued coalesce into one pass', async () => {
    const r = await rig()
    r.set([candidate('auto')])
    r.reconciler.requestPass()
    r.reconciler.requestPass()
    r.reconciler.requestPass()
    await r.reconciler.settled()
    expect(r.passes()).toBe(1)
    expect(r.emitted).toHaveLength(1)
  })
})
