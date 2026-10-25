/**
 * The `training-provider` contract, ONE suite run against every adapter (D805):
 * the fake, and the Modal provider over a recorded gateway. What any provider
 * must guarantee for the orchestrator to be correct:
 *
 *  - the dataset behind a ticket lands whole, and its sha256 is what was sent;
 *  - a retried submit for the same jobKey never starts a second job;
 *  - an unknown jobKey is `lost`, never an error;
 *  - cancel and cleanup are idempotent, and a cleaned job leaves `listJobs`;
 *  - events come back in order behind an opaque cursor, never twice;
 *  - no result before the job wrote one.
 */
import { describe, expect, it } from 'vitest'
import { FakeTrainingProvider } from '../providers/fake/fake-provider.js'
import { MemoryPeerBytes } from '../providers/fake/memory-peer-bytes.js'
import { sha } from './harness.js'
import { JOB, modalSubject, type Subject } from './modal-subject.js'
function fakeSubject(): Subject {
  const peer = new MemoryPeerBytes()
  const provider = new FakeTrainingProvider({ peer, now: () => 1000 })
  return {
    provider,
    addonId: provider.addonId,
    entryId: provider.defaultEntryId,
    peer,
    finish: (lines) => {
      provider.emit(JOB, ...lines)
      provider.finish(JOB, { resultText: '{"status":"succeeded"}', bundle: Buffer.from('b') })
      provider.advance(JOB, 'succeeded')
    },
  }
}

const SUBJECTS: ReadonlyArray<readonly [string, () => Subject]> = [
  ['fake', fakeSubject],
  ['modal (recorded gateway)', modalSubject],
]

async function submit(s: Subject) {
  return s.provider.submitJob({
    entryId: s.entryId,
    jobKey: JOB,
    trainer: { repo: 'camstack/camstack-trainer', revision: 'ebeed67a' },
    jobSpecJson: '{"schema":"camstack.training/v1"}',
    gpuType: 'L4',
    region: '',
    maxRuntimeSec: 3600,
  })
}

describe.each(SUBJECTS)('training-provider contract — %s', (_name, make) => {
  it('describes itself with its settings and never its credentials', async () => {
    const s = make()
    const [d] = await s.provider.describe({})
    expect(d?.addonId).toBe(s.addonId)
    expect(d?.entryId).toBe(s.entryId)
    expect(d?.configured).toBe(true)
    expect(JSON.stringify(d)).not.toMatch(/as-y/)
  })

  it('lands the dataset whole and answers its sha256', async () => {
    const s = make()
    const body = Buffer.alloc(300_000, 7)
    const got = await s.provider.uploadDataset({
      entryId: s.entryId,
      jobKey: JOB,
      ticket: s.peer.offer(body),
    })
    expect(got).toEqual({ bytes: body.length, sha256: sha(body) })
    expect(s.peer.outstanding).toBe(0)
  })

  it('never starts a second job for a retried submit', async () => {
    const s = make()
    const a = await submit(s)
    const b = await submit(s)
    expect(a.providerJobId).toBe(b.providerJobId)
    expect(
      (await s.provider.listJobs({ entryId: s.entryId })).filter((j) => j.jobKey === JOB),
    ).toHaveLength(1)
  })

  it('answers lost for a job it does not know', async () => {
    const s = make()
    expect((await s.provider.getJob({ entryId: s.entryId, jobKey: JOB })).state).toBe('lost')
  })

  it('has no result before the job writes one, then returns it', async () => {
    const s = make()
    await submit(s)
    expect((await s.provider.readResult({ entryId: s.entryId, jobKey: JOB })).found).toBe(false)
    s.finish([])
    expect((await s.provider.getJob({ entryId: s.entryId, jobKey: JOB })).state).toBe('succeeded')
    const result = await s.provider.readResult({ entryId: s.entryId, jobKey: JOB })
    expect(result.text).toBe('{"status":"succeeded"}')
    const { ticket } = await s.provider.offerArtifact({
      entryId: s.entryId,
      jobKey: JOB,
      path: 'bundle.tar',
    })
    expect((await s.peer.take(ticket)).bytes.toString()).toBe('b')
  })

  it('pages events in order behind a cursor, never twice', async () => {
    const s = make()
    await submit(s)
    s.finish(['one', 'two', 'three'])
    const first = await s.provider.listJobEvents({
      entryId: s.entryId,
      jobKey: JOB,
      max: 2,
    })
    const rest = await s.provider.listJobEvents({
      entryId: s.entryId,
      jobKey: JOB,
      max: 500,
      cursor: first.cursor,
    })
    const again = await s.provider.listJobEvents({
      entryId: s.entryId,
      jobKey: JOB,
      max: 500,
      cursor: rest.cursor,
    })
    expect([...first.lines, ...rest.lines].map((l) => l.text)).toEqual(['one', 'two', 'three'])
    expect(again.lines).toEqual([])
  })

  it('cancels and cleans up idempotently, and a cleaned job leaves listJobs', async () => {
    const s = make()
    await s.provider.uploadDataset({
      entryId: s.entryId,
      jobKey: JOB,
      ticket: s.peer.offer(Buffer.from('x')),
    })
    await submit(s)
    await s.provider.cancelJob({ entryId: s.entryId, jobKey: JOB })
    await s.provider.cancelJob({ entryId: s.entryId, jobKey: JOB })
    expect((await s.provider.getJob({ entryId: s.entryId, jobKey: JOB })).state).toBe('cancelled')
    const first = await s.provider.cleanupJob({ entryId: s.entryId, jobKey: JOB })
    const second = await s.provider.cleanupJob({ entryId: s.entryId, jobKey: JOB })
    expect(first.deleted.length).toBe(1)
    expect(second.deleted).toEqual([])
    expect((await s.provider.listJobs({ entryId: s.entryId })).some((j) => j.jobKey === JOB)).toBe(
      false,
    )
  })
})
