import { describe, expect, it, vi } from 'vitest'
import { reapDeadEgressHandles, type HeldEgressHandle } from '../egress/egress-handle-reaper.js'

const A: HeldEgressHandle = { deviceId: 106, sessionId: 's-a', pipelineKey: 'egress:a' }
const B: HeldEgressHandle = { deviceId: 106, sessionId: 's-b', pipelineKey: 'egress:b' }

describe('reapDeadEgressHandles', () => {
  it('reclaims a handle whose session the broker says is gone', async () => {
    // The measured leak: an Echo got stuck, never sent SessionDisconnected, and
    // a 720p transcode ran for nobody for twenty minutes.
    const dead = await reapDeadEgressHandles({ held: [A], isAlive: async () => false })
    expect(dead).toEqual([A])
  })

  it('keeps a handle whose session is alive', async () => {
    expect(await reapDeadEgressHandles({ held: [A], isAlive: async () => true })).toEqual([])
  })

  it('KEEPS a handle it could not ask about — a failed read is not a death', async () => {
    // Releasing on an unanswered question would black out a working Echo
    // session to save a process. Unknown is not dead (D393).
    expect(await reapDeadEgressHandles({ held: [A], isAlive: async () => null })).toEqual([])
  })

  it('judges each handle on its own', async () => {
    const isAlive = vi.fn(async (h: HeldEgressHandle) => h.sessionId !== 's-b')
    expect(await reapDeadEgressHandles({ held: [A, B], isAlive })).toEqual([B])
    expect(isAlive).toHaveBeenCalledTimes(2)
  })
})
