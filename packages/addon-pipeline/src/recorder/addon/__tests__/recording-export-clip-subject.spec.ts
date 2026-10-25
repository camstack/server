/**
 * `createExport` with `subject.kind:'clip'` — the recorder's clip branch.
 *
 * Every assertion here is a refusal that must be NAMED, or a projection that
 * must come from the catalog row and from nothing a caller supplied (D558).
 */
import type { Clip, ExportClipSubject, ExportOptions } from '@camstack/types'
import { clipExportFailureOf, exportSubjectOf } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { ExportClipCatalog } from '../export-clip-catalog.js'
import { getExportRecord } from '../export-store.js'
import {
  buildRecordingExportProvider,
  type ExportEngineHandle,
  type ExportRecordingIndex,
  type RecordingExportProviderDeps,
} from '../recording-export-provider.js'
import { expectExportRefusal } from '../../../__tests__/support/export-refusal-error.js'
import { makeExportsState } from './exports-state-fixture.js'

const OPTIONS: ExportOptions = {
  speed: 1,
  includeAudio: false,
  maxLifeMs: 604_800_000,
  deleteAfterDownload: false,
}

const DAY = { sinceMs: 1_758_326_400_000, untilMs: 1_758_412_800_000 }

const SUBJECT: ExportClipSubject = {
  kind: 'clip',
  deviceId: 107,
  provider: 'provider-reolink',
  source: 'native:reolink:onboard',
  sourceLabel: 'SD card',
  clipId: 'native:reolink:onboard:20260920_192927',
  profile: 'high',
  catalogWindow: DAY,
}

function clipRow(over: Partial<Clip> = {}): Clip {
  return {
    id: SUBJECT.clipId,
    source: SUBJECT.source,
    kind: 'native',
    timeRange: { startMs: 1_758_398_967_000, endMs: 1_758_398_996_000 },
    streams: { sub: { id: 's' }, main: { id: 'm' } },
    ...over,
  }
}

function fakeCatalog(rows: readonly Clip[] | Error): ExportClipCatalog & {
  readonly asked: Array<Record<string, unknown>>
} {
  const asked: Array<Record<string, unknown>> = []
  return {
    asked,
    listClips: async (input) => {
      asked.push({ ...input })
      if (rows instanceof Error) throw rows
      return rows
    },
  }
}

const EMPTY_INDEX: ExportRecordingIndex = { segmentsInWindow: async () => [] }

async function makeDeps(catalog: ExportClipCatalog): Promise<{
  deps: RecordingExportProviderDeps
  engine: ExportEngineHandle & { enqueued: string[] }
}> {
  const enqueued: string[] = []
  const engine = { enqueue: (id: string) => void enqueued.push(id), cancel: () => {}, enqueued }
  const deps: RecordingExportProviderDeps = {
    state: await makeExportsState(),
    engine,
    index: EMPTY_INDEX,
    clipCatalog: catalog,
    now: () => 5_000,
    newId: () => 'exp-clip-1',
    createdBy: () => 'operator',
    outPath: (rec) => `/data/exports/${rec.deviceId}/${rec.id}.mp4`,
    removeFile: async () => {},
    downloadUrlFor: (id) => `/addon/recorder/exports/${id}.mp4`,
    statBytes: async () => 4,
    readFile: async () => Buffer.from('mp4!'),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  }
  return { deps, engine }
}

async function create(
  catalog: ExportClipCatalog,
  subject: ExportClipSubject = SUBJECT,
  options: ExportOptions = OPTIONS,
): ReturnType<ReturnType<typeof buildRecordingExportProvider>['createExport']> {
  const { deps } = await makeDeps(catalog)
  return buildRecordingExportProvider(deps).createExport({
    deviceId: subject.deviceId,
    subject,
    options,
  })
}

describe('createExport — a clip subject', () => {
  it('asks the ONE provider the subject names, never the union of the camera’s sources', async () => {
    // D554 amended: `listClips` has no default provider. A bare call answered
    // the union of every source on 592 with `limit` meaning `limit × sources`.
    const catalog = fakeCatalog([clipRow()])
    await create(catalog)
    expect(catalog.asked).toHaveLength(1)
    expect(catalog.asked[0]).toMatchObject({
      deviceId: 107,
      provider: 'provider-reolink',
      since: DAY.sinceMs,
      until: DAY.untilMs,
    })
  })

  it('projects fromMs/toMs from the CATALOG ROW — the camera’s boundaries', async () => {
    const rec = await create(fakeCatalog([clipRow()]))
    expect(rec.fromMs).toBe(1_758_398_967_000)
    expect(rec.toMs).toBe(1_758_398_996_000)
    expect(rec.state).toBe('queued')
    expect(rec.progressPct).toBeNull()
    // The subject stays the authority, and it carries no range of its own.
    expect(exportSubjectOf(rec)).toEqual(SUBJECT)
  })

  it('queues exactly ONE job — one tap is never two fetches, nor two wakes', async () => {
    const { deps, engine } = await makeDeps(fakeCatalog([clipRow()]))
    const rec = await buildRecordingExportProvider(deps).createExport({
      deviceId: 107,
      subject: SUBJECT,
      options: OPTIONS,
    })
    expect(engine.enqueued).toEqual([rec.id])
    expect(await getExportRecord(deps.state, rec.id)).not.toBeNull()
  })

  it('projects the twin that will be SERVED, not the one asked for', async () => {
    // D549 15 / D558 § 5.4.2 rule 3. Measured on 592: 17 of 546 clips have no
    // main twin, so a silent fallback is right 96.9 % of the time and hands
    // the operator the worst copy the camera holds on the rest.
    const rec = await create(fakeCatalog([clipRow({ streams: { sub: { id: 's' } } })]))
    expect(rec.profile).toBe('low')
    // …and the ASK survives on the subject, so the modal can render both.
    const subject = exportSubjectOf(rec)
    expect(subject.kind === 'clip' && subject.profile).toBe('high')
  })

  it('refuses a clip the source no longer lists, by name', async () => {
    await expect(create(fakeCatalog([]))).rejects.toThrow(/catalog-miss/)
  })

  it('refuses when the catalog itself could not be read — never as “no such clip”', async () => {
    // A read that FAILS and a read that ANSWERED NOTHING are different facts
    // (D49). Collapsing them tells the operator his clip is gone when the
    // camera was merely unreachable.
    const err = await expectExportRefusal(() =>
      create(fakeCatalog(new Error('camera unreachable'))),
    )
    expect(clipExportFailureOf(err.message)).toBe('catalog-unreachable')
    expect(err.message).toContain('camera unreachable')
  })

  it('refuses a row with no bytes behind it, carrying the source’s own reason', async () => {
    const err = await expectExportRefusal(() =>
      create(fakeCatalog([clipRow({ playable: false, unplayableReason: 'no-file-for-window' })])),
    )
    expect(clipExportFailureOf(err.message)).toBe('no-file-for-window')
    expect(err.message).toContain('no-file-for-window')
  })

  it('refuses a clip that is still being written', async () => {
    // D567/D570: `inProgress` says in as many words that `endMs` is not the
    // clip's end — 592 reported the same `endTime` for eight minutes while the
    // file grew. An export of one would project a duration nobody knows, and
    // D568's completion rule (decoded duration vs the catalog span) has
    // nothing to prove itself against.
    const err = await expectExportRefusal(() =>
      create(fakeCatalog([clipRow({ inProgress: true })])),
    )
    expect(clipExportFailureOf(err.message)).toBe('clip-in-progress')
  })

  it('refuses a render option a remux cannot honour, rather than rendering “Real time (1×)”', async () => {
    // Nothing is re-timed on this path — the file is fetched and remuxed. A
    // speed or a timelapse silently ignored is a claim the record would carry
    // for its whole life.
    const err = await expectExportRefusal(() =>
      create(fakeCatalog([clipRow()]), SUBJECT, { ...OPTIONS, speed: 4 }),
    )
    expect(clipExportFailureOf(err.message)).toBe('unsupported-option')
    const err2 = await expectExportRefusal(() =>
      create(fakeCatalog([clipRow()]), SUBJECT, {
        speed: undefined,
        timelapse: { everyMs: 1_000 },
        includeAudio: false,
        maxLifeMs: 1_000,
        deleteAfterDownload: false,
      }),
    )
    expect(clipExportFailureOf(err2.message)).toBe('unsupported-option')
  })

  it('never invents a wake: the flag reaches the record exactly as the operator set it', async () => {
    const withWake: ExportClipSubject = { ...SUBJECT, wake: 'authorised' }
    const rec = await create(fakeCatalog([clipRow()]), withWake)
    const subject = exportSubjectOf(rec)
    expect(subject.kind === 'clip' && subject.wake).toBe('authorised')

    const without = await create(fakeCatalog([clipRow()]))
    const plain = exportSubjectOf(without)
    expect(plain.kind === 'clip' && plain.wake).toBeUndefined()
  })
})
