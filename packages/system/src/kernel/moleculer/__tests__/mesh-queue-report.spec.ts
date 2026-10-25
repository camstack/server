/**
 * The Moleculer writer sockets are the one outbound plane `_getActiveHandles()`
 * cannot see (D446): `TcpWriter.connect` unrefs every socket it opens, so a
 * write backlog to an agent is invisible to the census that excluded "every
 * socket queue" on 2026-09-10. This reader walks the writer's socket map and
 * reports `writableLength` per node, and says NOTHING when the transporter
 * has no such map — the `Fake` transporter of every test broker, a broker
 * that does not exist yet.
 */
import { describe, expect, it } from 'vitest'
import { createMeshQueueReader, formatMeshQueue } from '../mesh-queue-report.js'

const MB = 1048576

function socketLike(writableLength: number, bytesWritten: number): unknown {
  return { writableLength, bytesWritten }
}

function brokerWith(sockets: Map<string, unknown>): unknown {
  return { transit: { tx: { writer: { sockets } } } }
}

describe('reading the writer sockets', () => {
  it('reports every node the writer holds a socket to, with its queue and its lifetime bytes', () => {
    const read = createMeshQueueReader(() =>
      brokerWith(
        new Map([
          ['agent-a', socketLike(0, 12 * MB)],
          ['MacMiniAgent.localdomain', socketLike(300 * MB, 900 * MB)],
        ]),
      ),
    )
    expect(read()).toEqual([
      { nodeId: 'agent-a', queuedBytes: 0, bytesWritten: 12 * MB },
      { nodeId: 'MacMiniAgent.localdomain', queuedBytes: 300 * MB, bytesWritten: 900 * MB },
    ])
  })

  it('is undefined — not empty — when there is no broker, no transit, or no TCP writer', () => {
    expect(createMeshQueueReader(() => null)()).toBeUndefined()
    expect(createMeshQueueReader(() => ({}))()).toBeUndefined()
    expect(createMeshQueueReader(() => ({ transit: { tx: {} } }))()).toBeUndefined()
  })

  it('skips a socket entry that carries no numbers, and never throws out of a broker mid-teardown', () => {
    const read = createMeshQueueReader(() =>
      brokerWith(
        new Map<string, unknown>([
          ['ok', socketLike(5, 6)],
          ['odd', { writableLength: 'x' }],
        ]),
      ),
    )
    expect(read()).toEqual([{ nodeId: 'ok', queuedBytes: 5, bytesWritten: 6 }])
    const throwing = createMeshQueueReader(() => {
      throw new Error('broker is gone')
    })
    expect(throwing()).toBeUndefined()
  })
})

describe('the line', () => {
  it('prints the total always and names only the nodes with a queue, largest first', () => {
    const line = formatMeshQueue([
      { nodeId: 'agent-a', queuedBytes: 2 * MB, bytesWritten: 1 },
      { nodeId: 'MacMiniAgent.localdomain', queuedBytes: 300 * MB, bytesWritten: 1 },
      { nodeId: 'hub-test', queuedBytes: 0, bytesWritten: 0 },
    ])
    expect(line).toContain(' meshQueued=309248kB')
    expect(line).toContain(' meshQueuedTop=MacMiniAgent.localdomain:307200,agent-a:2048')
    expect(line).not.toContain('hub-test')
  })

  it('a quiet mesh prints the total at zero and no ranking', () => {
    const line = formatMeshQueue([{ nodeId: 'agent-a', queuedBytes: 0, bytesWritten: 1 }])
    expect(line).toBe(' meshQueued=0kB')
  })

  it('a process with no mesh writer contributes nothing to the line', () => {
    expect(formatMeshQueue(undefined)).toBe('')
  })
})
