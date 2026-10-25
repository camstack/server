/**
 * The boot reconcile is where "one request, one wake" is easiest to break.
 *
 * `reconcileInterruptedExports` hands every interrupted row back to the engine
 * — which is exactly right for a render (an ffmpeg died with the process and
 * nothing outside this box notices it running again). For a clip export
 * carrying an operator's authorised wake it is not: the row would reach the
 * fetch hours later and spend a yes the operator gave once, to a camera he is
 * no longer standing in front of. D558 § 5.2 rule 3 names this as one of the
 * three ways the rule breaks without anybody meaning it.
 */
import type { ExportClipSubject, ExportRecord } from '@camstack/types'
import { clipExportFailureOf } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { reconcileInterruptedExports } from '../export-reconcile.js'
import { getExportRecord, upsertExport } from '../export-store.js'
import { makeExportsState } from './exports-state-fixture.js'

const NOW = 1_758_400_000_000

const SUBJECT: ExportClipSubject = {
  kind: 'clip',
  deviceId: 106,
  provider: 'provider-reolink',
  source: 'native:reolink:onboard',
  sourceLabel: 'SD card',
  clipId: 'native:reolink:onboard:20260920_192927',
  catalogWindow: { sinceMs: NOW - 86_400_000, untilMs: NOW },
  profile: 'low',
}

function row(over: Partial<ExportRecord> = {}): ExportRecord {
  return {
    id: 'r1',
    deviceId: 106,
    profile: 'low',
    fromMs: NOW - 30_000,
    toMs: NOW,
    options: { speed: 1, includeAudio: false, maxLifeMs: 604_800_000, deleteAfterDownload: false },
    state: 'queued',
    progressPct: null,
    fileBytes: null,
    expiresAt: NOW + 604_800_000,
    deleteAfterDownload: false,
    downloadedAt: null,
    createdAt: NOW - 3_600_000,
    createdBy: 'operator',
    error: null,
    ...over,
  }
}

async function reconcile(record: ExportRecord): Promise<{
  requeued: string[]
  rec: ExportRecord | null
}> {
  const state = await makeExportsState()
  await upsertExport(state, record)
  const requeued: string[] = []
  await reconcileInterruptedExports({
    state,
    engine: { enqueue: (id) => void requeued.push(id) },
    now: () => NOW,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  })
  return { requeued, rec: await getExportRecord(state, record.id) }
}

describe('boot reconcile — a wake is never spent twice', () => {
  it('fails an interrupted clip export that carried an authorised wake', async () => {
    const out = await reconcile(row({ subject: { ...SUBJECT, wake: 'authorised' } }))
    expect(out.requeued).toEqual([])
    expect(out.rec?.state).toBe('failed')
    expect(clipExportFailureOf(out.rec?.error ?? null)).toBe('wake-expired')
  })

  it('re-queues an interrupted clip export that carried NO wake', async () => {
    // Nothing to spend twice: a camera that is awake answers, and one that is
    // asleep refuses at its own gate, exactly as it did the first time.
    const out = await reconcile(row({ subject: SUBJECT }))
    expect(out.requeued).toEqual(['r1'])
    expect(out.rec?.state).toBe('queued')
  })

  it('still re-queues an interrupted footage render', async () => {
    const out = await reconcile(row({ subject: undefined }))
    expect(out.requeued).toEqual(['r1'])
    expect(out.rec?.state).toBe('queued')
  })
})
