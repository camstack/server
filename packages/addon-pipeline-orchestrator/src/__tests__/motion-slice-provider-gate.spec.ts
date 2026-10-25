/**
 * D696, amended 2026-10-02: the provider half of the writer gate. The
 * orchestrator writes a camera's `motion` slice only once the camera's OWN
 * provider has answered `deviceProvider.getStatus` with
 * `motionSliceWriter: 'orchestrator'`, when that provider is one of the four
 * that wrote the slice before D696. An old provider answers WITHOUT the field
 * and still writes (raw VMD edges, a boot seed), so its cameras stay
 * unwritten; every other camera is untouched by it (the gate is per camera).
 */
import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type CameraOwner,
  type CameraOwnersRead,
  PRE_D696_PROVIDER_SLICE_WRITERS,
  PROVIDER_GATE_STALE_REFRESH_MS,
  ProviderSliceGate,
  type ProviderSliceWriterRead,
} from '../camera-sensors/motion-slice-provider-gate.js'

const HIK_CAM = 101
const HIK_CAM_2 = 616
const REO_CAM = 700
const ONVIF_CAM = 800

interface Line {
  readonly level: string
  readonly message: string
  readonly deviceId: unknown
  readonly meta: Readonly<Record<string, unknown>> | undefined
}

type StatusAnswer = ProviderSliceWriterRead | 'pending'

const NEW: ProviderSliceWriterRead = { kind: 'answered', motionSliceWriter: 'orchestrator' }
const OLD: ProviderSliceWriterRead = { kind: 'answered', motionSliceWriter: null }
const FAILED: ProviderSliceWriterRead = { kind: 'unreadable', error: 'UDS request timed out' }

const OWNERS: readonly CameraOwner[] = [
  { id: HIK_CAM, addonId: 'provider-hikvision' },
  { id: HIK_CAM_2, addonId: 'provider-hikvision' },
  { id: REO_CAM, addonId: 'provider-reolink' },
  { id: ONVIF_CAM, addonId: 'provider-onvif' },
]

function harness(initial: Readonly<Record<string, StatusAnswer>>) {
  const lines: Line[] = []
  const record =
    (level: string) =>
    (
      message: string,
      extras?: {
        tags?: Readonly<Record<string, unknown>>
        meta?: Readonly<Record<string, unknown>>
      },
    ): void => {
      lines.push({ level, message, deviceId: extras?.tags?.['deviceId'], meta: extras?.meta })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  const answers = new Map<string, StatusAnswer>(Object.entries(initial))
  let owners: CameraOwnersRead = { kind: 'rows', rows: OWNERS }
  const asked: string[] = []
  const pending = new Map<string, (read: ProviderSliceWriterRead) => void>()
  const changes: number[][] = []
  let now = 0
  const gate = new ProviderSliceGate({
    logger,
    listCameraOwners: async () => owners,
    readProviderStatus: (addonId) => {
      asked.push(addonId)
      const answer = answers.get(addonId) ?? FAILED
      if (answer !== 'pending') return Promise.resolve(answer)
      return new Promise<ProviderSliceWriterRead>((resolve) => pending.set(addonId, resolve))
    },
    now: () => now,
    onChange: (ids) => changes.push([...ids]),
  })
  return {
    gate,
    lines,
    asked,
    changes,
    setAnswer: (addonId: string, answer: StatusAnswer) => answers.set(addonId, answer),
    setOwners: (read: CameraOwnersRead) => {
      owners = read
    },
    /** Settles once the gate has asked `addonId` and its read is in flight. */
    inFlight: async (addonId: string): Promise<void> => {
      for (let i = 0; i < 100 && !pending.has(addonId); i += 1) await Promise.resolve()
      expect(pending.has(addonId)).toBe(true)
    },
    answerPending: (addonId: string, read: ProviderSliceWriterRead) => {
      pending.get(addonId)?.(read)
      pending.delete(addonId)
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('ProviderSliceGate — a camera of an old provider is never written (D696 amended)', () => {
  it('an OLD provider (no field) keeps its cameras closed; a camera of another provider is open', async () => {
    const h = harness({ 'provider-hikvision': OLD, 'provider-reolink': NEW })
    await h.gate.refresh('boot')
    expect(h.gate.verdictOf(HIK_CAM)).toEqual({ open: false, why: 'old-provider' })
    expect(h.gate.isCameraOpen(HIK_CAM_2)).toBe(false)
    expect(h.gate.isCameraOpen(REO_CAM)).toBe(true)
    // An old provider is a WARN per camera, tagged with the camera.
    expect(
      h.lines.some(
        (l) =>
          l.level === 'warn' &&
          l.deviceId === HIK_CAM &&
          l.message.startsWith('camera motion slice: provider gate closed'),
      ),
    ).toBe(true)
  })

  it('a NEW provider (motionSliceWriter: orchestrator) opens its cameras', async () => {
    const h = harness({ 'provider-hikvision': NEW, 'provider-reolink': NEW })
    await h.gate.refresh('boot')
    expect(h.gate.verdictOf(HIK_CAM)).toEqual({ open: true, why: 'answered' })
    expect(h.changes.flat().toSorted()).toEqual([HIK_CAM, HIK_CAM_2, REO_CAM, ONVIF_CAM])
  })

  it('a provider that never wrote the slice is not asked, and its cameras are open', async () => {
    const h = harness({})
    await h.gate.refresh('boot')
    expect(h.gate.verdictOf(ONVIF_CAM)).toEqual({ open: true, why: 'not-a-writer' })
    expect(h.asked.toSorted()).toEqual(['provider-hikvision', 'provider-reolink'])
  })

  it('an unanswered provider keeps its cameras closed; before any listing every camera is closed', async () => {
    const h = harness({ 'provider-hikvision': FAILED, 'provider-reolink': NEW })
    expect(h.gate.verdictOf(ONVIF_CAM)).toEqual({ open: false, why: 'owner-unknown' })
    await h.gate.refresh('boot')
    expect(h.gate.verdictOf(HIK_CAM)).toEqual({ open: false, why: 'unanswered' })
  })

  it('D49: a failed read changes nothing — it neither opens an old provider`s cameras nor closes a new one`s', async () => {
    const h = harness({ 'provider-hikvision': NEW, 'provider-reolink': OLD })
    await h.gate.refresh('boot')
    h.setAnswer('provider-hikvision', FAILED)
    h.setAnswer('provider-reolink', FAILED)
    h.setOwners({ kind: 'unreadable', error: 'settings door busy' })
    await h.gate.refresh('motion-edge')
    expect(h.gate.isCameraOpen(HIK_CAM)).toBe(true)
    expect(h.gate.verdictOf(REO_CAM)).toEqual({ open: false, why: 'old-provider' })
  })

  it('a provider process coming up (WorkerOnline) closes its cameras at once; a fresh answer decides', async () => {
    const h = harness({ 'provider-hikvision': NEW, 'provider-reolink': NEW })
    await h.gate.refresh('boot')
    h.gate.forgetProcess('hub/provider-hikvision')
    // Synchronously, before the rolled-back process can restore a device.
    expect(h.gate.verdictOf(HIK_CAM)).toEqual({ open: false, why: 'unanswered' })
    expect(h.gate.isCameraOpen(REO_CAM)).toBe(true)
    h.setAnswer('provider-hikvision', OLD)
    await h.gate.refresh('worker-online')
    expect(h.gate.verdictOf(HIK_CAM)).toEqual({ open: false, why: 'old-provider' })
  })

  it('a process of another addon coming up changes nothing; a bare node id (agent) forgets every provider', async () => {
    const h = harness({ 'provider-hikvision': NEW, 'provider-reolink': NEW })
    await h.gate.refresh('boot')
    h.gate.forgetProcess('hub/detection')
    expect(h.gate.isCameraOpen(HIK_CAM)).toBe(true)
    h.gate.forgetProcess('agent-a')
    expect(h.gate.isCameraOpen(HIK_CAM)).toBe(false)
    expect(h.gate.isCameraOpen(REO_CAM)).toBe(false)
    expect(h.gate.isCameraOpen(ONVIF_CAM)).toBe(true)
  })

  it('L2: a flap — forgotten (an agent reconnect), then answered as before — is said on its first occurrence and then sampled, per camera', async () => {
    const h = harness({ 'provider-hikvision': NEW, 'provider-reolink': NEW })
    await h.gate.refresh('boot')
    const said = (): number =>
      h.lines.filter(
        (l) => l.deviceId === HIK_CAM && l.message.startsWith('camera motion slice: provider gate'),
      ).length
    const atBoot = said()
    for (let i = 0; i < 5; i += 1) {
      h.gate.forgetProcess('agent-a')
      await h.gate.refresh('agent-online')
    }
    // The first flap: its close and its reopen. The next four: nothing.
    expect(said() - atBoot).toBe(2)
    expect(h.gate.isCameraOpen(HIK_CAM)).toBe(true)
    // An OLD provider found after a flap is never sampled away.
    h.gate.forgetProcess('agent-a')
    h.setAnswer('provider-hikvision', OLD)
    await h.gate.refresh('agent-online')
    expect(
      h.lines.some(
        (l) => l.level === 'warn' && l.deviceId === HIK_CAM && l.meta?.['why'] === 'old-provider',
      ),
    ).toBe(true)
  })

  it('D58: a provider whose process LEFT (WorkerOffline) cannot write — its cameras open, until it comes back', async () => {
    const h = harness({ 'provider-hikvision': OLD, 'provider-reolink': NEW })
    await h.gate.refresh('boot')
    h.gate.noteProcessGone('hub/provider-hikvision')
    expect(h.gate.verdictOf(HIK_CAM)).toEqual({ open: true, why: 'gone' })
    h.gate.forgetProcess('hub/provider-hikvision')
    expect(h.gate.verdictOf(HIK_CAM)).toEqual({ open: false, why: 'unanswered' })
  })

  it('an answer read BEFORE the provider`s latest coming-up is the previous process speaking — dropped', async () => {
    const h = harness({ 'provider-hikvision': 'pending', 'provider-reolink': NEW })
    const census = h.gate.refresh('boot')
    await h.inFlight('provider-hikvision')
    // The new (rolled-back) process came up while the old one's answer was in flight.
    h.gate.forgetProcess('hub/provider-hikvision')
    h.answerPending('provider-hikvision', NEW)
    await census
    expect(h.gate.verdictOf(HIK_CAM)).toEqual({ open: false, why: 'unanswered' })
  })

  it('a motion edge on a closed camera asks for a census at most once per window', async () => {
    const h = harness({ 'provider-hikvision': FAILED, 'provider-reolink': NEW })
    await h.gate.refresh('boot')
    const before = h.asked.length
    h.gate.refreshIfStale()
    await Promise.resolve()
    expect(h.asked.length).toBe(before)
    h.advance(PROVIDER_GATE_STALE_REFRESH_MS)
    h.setAnswer('provider-hikvision', NEW)
    h.gate.refreshIfStale()
    await h.gate.refresh('motion-edge')
    expect(h.gate.isCameraOpen(HIK_CAM)).toBe(true)
  })
})

describe('the pre-D696 provider writers are real addons (a renamed id would silently open its cameras)', () => {
  it('every id is an addon a provider package declares in its manifest', () => {
    const packages = path.resolve(import.meta.dirname, '../../..')
    const declared = new Set<string>()
    for (const dir of readdirSync(packages).filter((d) => d.startsWith('addon-provider-'))) {
      const manifest: unknown = JSON.parse(
        readFileSync(path.join(packages, dir, 'package.json'), 'utf-8'),
      )
      const camstack =
        typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'camstack') : null
      const addons =
        typeof camstack === 'object' && camstack !== null ? Reflect.get(camstack, 'addons') : null
      if (!Array.isArray(addons)) continue
      for (const addon of addons) {
        const id = typeof addon === 'object' && addon !== null ? Reflect.get(addon, 'id') : null
        if (typeof id === 'string') declared.add(id)
      }
    }
    for (const id of PRE_D696_PROVIDER_SLICE_WRITERS) expect(declared).toContain(id)
  })
})
