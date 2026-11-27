/**
 * `adoptionStartJob` hands the signed-in user to the engine as the job owner (planning#719): the
 * jobs ledger shows a manual adoption to whoever started it. The cap is `caller: 'required'`, so
 * every start through it carries a caller; an in-process start (autopilot) calls the engine
 * directly and files the job under `system`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AdoptionJobEngine } from '../adoption-job-engine.js'
import type { ProviderContext } from '../device-provider-context.js'
import { adoptionStartJob } from '../device-queries.js'

type StartInput = Parameters<typeof adoptionStartJob>[1]
type EngineStartInput = Parameters<AdoptionJobEngine['start']>[0]

function makeContext() {
  const start = vi.fn(async (_input: EngineStartInput) => ({ jobId: 'adopt-1' }))
  const pctx = { host: { adoptionJobs: { start } } } as unknown as ProviderContext
  return { pctx, start }
}

const BASE: Omit<StartInput, 'caller'> = {
  addonId: 'provider-ha',
  integrationId: 'int_1',
  childNativeIds: ['a', 'b'],
}

describe('adoptionStartJob owner', () => {
  it('passes the calling user as the job owner', async () => {
    const { pctx, start } = makeContext()
    await adoptionStartJob(pctx, { ...BASE, caller: { userId: 'alice', isAdmin: true } })
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      ownerUserId: 'alice',
      addonId: 'provider-ha',
      integrationId: 'int_1',
      childNativeIds: ['a', 'b'],
    })
  })

  it('passes a non-admin caller as the owner too', async () => {
    const { pctx, start } = makeContext()
    await adoptionStartJob(pctx, { ...BASE, caller: { userId: 'bob', isAdmin: false } })
    expect(start.mock.calls[0]?.[0]).toMatchObject({ ownerUserId: 'bob' })
  })
})
