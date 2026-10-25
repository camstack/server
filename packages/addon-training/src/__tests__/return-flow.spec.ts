/**
 * The return flow (D805, D806): register only from `ready`, with complete
 * rows whose every URL is `camstack-local://` and whose files are exactly the
 * bundle's; a canary pins the ACCELERATOR (a model is chosen by the
 * accelerator that runs it, D927) — INT8 where it ran INT8 — and remembers
 * what it replaced; rollback restores it EXACTLY (an absent pin stays absent);
 * discard deletes the staged artefacts.
 */
import { describe, expect, it } from 'vitest'
import { catalogEntryFromDraft, planCanary, ReturnFlow } from '../orchestrator/return-flow.js'
import { findBaseModel } from '../orchestrator/base-models.js'
import { fakeResult, harness } from './harness.js'

const REQUEST = {
  selection: { collectionIds: ['col-1'], workState: 'complete' as const },
  entryId: 'fake-default',
  gpuType: 'L4',
  region: '',
  baseModelId: 'yolov9m-640',
  preset: 'standard' as const,
  freeze: null,
  holdoutCameras: null,
  name: 'night fix',
  maxCostUsd: 3,
  maxRuntimeSec: 4 * 3600,
  idempotencyKey: 'idem-0001',
}

async function readyJob() {
  const h = await harness()
  const started = await h.engine.startJob(REQUEST)
  if (started.kind !== 'started') throw new Error('refused')
  await h.engine.settle()
  const id = started.job.id
  h.provider.finish(id, fakeResult(h.provider.jobs.get(id)?.jobSpecJson ?? ''))
  h.provider.advance(id, 'succeeded')
  await h.engine.tick()
  await h.engine.settle()
  const flow = new ReturnFlow(h.ports, h.engine.mutator)
  return { h, id, flow }
}

describe('training return flow', () => {
  it('registers both variants with local URLs and the bundle files', async () => {
    const { h, id, flow } = await readyJob()
    const job = await flow.register(id, [])
    expect(job.state).toBe('registered')
    const sent = h.imports[0]
    expect(sent?.entries.map((e) => e.id)).toEqual([
      job.registeredModelIds[0],
      job.registeredModelIds[1],
    ])
    for (const entry of sent?.entries ?? []) {
      for (const fmt of Object.values(entry.formats)) {
        expect(fmt?.url.startsWith(`camstack-local://${entry.id}/`)).toBe(true)
        expect(fmt?.revision).toMatch(/^[0-9a-f]{64}$/)
      }
    }
    expect(sent?.entries[1]?.suppliedLabelFloors).toEqual({ 'animal-classifier': 0.7 })
    expect(sent?.distribute).toBe(true)
    expect(h.peer.outstanding).toBe(0)
  })

  it('refuses to register anything but a ready result', async () => {
    const { id, flow } = await readyJob()
    await flow.register(id, [])
    await expect(flow.register(id, [])).rejects.toThrow(/only a ready result/)
  })

  it('canaries the chosen accelerators — INT8 where they ran INT8 — then rolls back exactly', async () => {
    const { h, id, flow } = await readyJob()
    h.pins.pins.set('mac|ane', 'yolov9m-640')
    const registered = await flow.register(id, [
      { nodeId: 'hub', deviceKey: 'npu' },
      { nodeId: 'mac', deviceKey: 'ane' },
    ])
    const [baseId, int8Id] = registered.registeredModelIds
    expect(registered.state).toBe('canary')
    expect(registered.canary?.accelerators).toEqual([
      { nodeId: 'hub', deviceKey: 'npu' },
      { nodeId: 'mac', deviceKey: 'ane' },
    ])
    expect(h.pins.pins.get('hub|npu')).toBe(int8Id)
    expect(h.pins.pins.get('mac|ane')).toBe(baseId)
    const rolled = await flow.rollback(id)
    expect(rolled.state).toBe('registered')
    expect(h.pins.pins.has('hub|npu')).toBe(false)
    expect(h.pins.pins.get('mac|ane')).toBe('yolov9m-640')
  })

  it('refuses an accelerator that does not run the root detector, and pins nothing', async () => {
    const { h, id, flow } = await readyJob()
    await flow.register(id, [])
    await expect(flow.canary(id, [{ nodeId: 'hub', deviceKey: 'gpu' }])).rejects.toThrow(
      /hub · gpu does not run the root detector/,
    )
    expect(h.pins.pins.size).toBe(0)
  })

  it('discards an unregistered result and its staged files', async () => {
    const { h, id, flow } = await readyJob()
    const job = await flow.discard(id)
    expect(job.state).toBe('discarded')
    expect(h.artifacts.bundles.has(id)).toBe(false)
  })

  it('surfaces a Model Studio refusal and leaves the job ready', async () => {
    const { h, id, flow } = await readyJob()
    h.importAnswer = () => ({ kind: 'refused', reason: 'checksum-mismatch', detail: 'x' })
    await expect(flow.register(id, [])).rejects.toThrow(/checksum-mismatch/)
    expect((await h.jobs.get(id))?.state).toBe('ready')
  })

  it('plans the base variant where nothing INT8 was registered', () => {
    const writes = planCanary({
      accelerators: [{ nodeId: 'hub', deviceKey: 'npu' }],
      devices: [{ nodeId: 'hub', deviceKey: 'npu', pinnedModelId: 'yolov9m-640-int8' }],
      baseId: 'b',
      int8Id: null,
    })
    expect(writes).toEqual([{ nodeId: 'hub', deviceKey: 'npu', modelId: 'b' }])
  })

  it('completes a draft into a valid catalog row', async () => {
    const { h, id } = await readyJob()
    const job = (await h.jobs.get(id))!
    const { result } = fakeResult(h.provider.jobs.get(id)?.jobSpecJson ?? '')
    const entry = catalogEntryFromDraft({
      draft: result.catalogDraft!.base,
      job,
      result,
      base: findBaseModel('yolov9m-640')!,
      int8: false,
    })
    expect(entry.license?.weights).toBe('AGPL-3.0-only')
    expect(entry.labels).toEqual([])
    expect(entry.preprocessMode).toBe('letterbox')
  })
})
