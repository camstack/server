import { ACTION_RUN_TIMEOUT_MS } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'

/**
 * A forked addon's outbound cap call is bounded on the CHILD's own socket. That
 * socket knows no cap definition, so a method that declares a long `timeoutMs`
 * (`actions.run`, which an automation step awaits for the whole run) used to be
 * cut at the 60 s default — the run went on, the caller was told it failed.
 *
 * Real `LocalChildClient` ↔ real `LocalChildRegistry` over a real UDS socket.
 */

const nid = () => `hub-callout-${process.pid}-${Math.random().toString(36).slice(2)}`

describe('child → parent cap call honours the declared timeoutMs', () => {
  let registry: LocalChildRegistry | null = null
  let child: LocalChildClient | null = null
  afterEach(async () => {
    vi.useRealTimers()
    await child?.close()
    child = null
    await registry?.close()
    registry = null
  })

  async function connect(
    onUnowned: () => Promise<unknown>,
    capTimeoutMs?: (cap: string, method: string) => number | undefined,
  ): Promise<LocalChildClient> {
    const nodeId = nid()
    registry = new LocalChildRegistry(createLocalTransport().createServer(nodeId), onUnowned)
    await registry.start()
    child = new LocalChildClient({
      nodeId,
      childId: 'caller',
      caps: [{ capName: 'ptz', mode: 'singleton' }],
      dispatch: async () => 'ok',
      ...(capTimeoutMs === undefined ? {} : { capTimeoutMs }),
    })
    await child.start()
    return child
  }

  it("cuts a call at the method's declared bound, not at the channel default", async () => {
    const slow = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 600))
    const client = await connect(slow, () => 150)
    await expect(client.callOut({ capName: 'slow', method: 'm', args: {} })).rejects.toThrow(
      /timed out after 150ms/,
    )
  })

  it('a long declared bound lets the call outlive the 60 s default', async () => {
    const answers: Array<() => void> = []
    const held = (): Promise<unknown> =>
      new Promise((resolve) => answers.push(() => resolve('done')))
    const client = await connect(held, (cap, method) =>
      cap === 'slow' && method === 'm' ? 120_000 : undefined,
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let settled = false
    const call = client.callOut({ capName: 'slow', method: 'm', args: {} }).then(
      (v) => ((settled = true), v),
      (e: unknown) => ((settled = true), Promise.reject(e)),
    )
    for (let i = 0; i < 200 && answers.length === 0; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(answers).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(settled).toBe(false)
    for (const answer of answers) answer()
    await expect(call).resolves.toBe('done')
  })

  it('actions.run, by the generated table, is not cut at 60 s or at the run ceiling', async () => {
    const answers: Array<() => void> = []
    const held = (): Promise<unknown> =>
      new Promise((resolve) => answers.push(() => resolve({ outcome: 'ran' })))
    const client = await connect(held)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let rejected: unknown = null
    const call = client
      .callOut({ capName: 'actions', method: 'run', args: {} })
      .catch((e: unknown) => {
        rejected = e
      })
    await vi.advanceTimersByTimeAsync(ACTION_RUN_TIMEOUT_MS - 1_000)
    expect(rejected).toBeNull()
    await vi.advanceTimersByTimeAsync(2_000)
    await call
    expect(String(rejected)).toMatch(new RegExp(`timed out after ${ACTION_RUN_TIMEOUT_MS}ms`))
  })
})
