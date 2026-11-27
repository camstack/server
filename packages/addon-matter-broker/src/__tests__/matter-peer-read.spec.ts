import { describe, expect, it } from 'vitest'
import { readPeerAttributes } from '../matter-peer-read.js'

/** A `ReadResult` stand-in: an async stream of chunks of decoded report records. */
async function* chunks(
  records: readonly unknown[],
): AsyncGenerator<readonly unknown[], void, undefined> {
  yield records
}

describe('readPeerAttributes', () => {
  it('asks for whole clusters per endpoint and decodes the answered attributes', async () => {
    const seen: unknown[] = []
    const peer = {
      interaction: {
        read: (request: unknown) => {
          seen.push(request)
          return chunks([
            {
              kind: 'attr-value',
              path: { endpointId: 0, clusterId: 0x33, attributeId: 2 },
              value: 3600,
            },
            // a status record and a null value are not measurements
            { kind: 'attr-status', path: { endpointId: 0, clusterId: 0x37, attributeId: 0 } },
            {
              kind: 'attr-value',
              path: { endpointId: 0, clusterId: 0x33, attributeId: 1 },
              value: null,
            },
          ])
        },
      },
    }
    const reports = await readPeerAttributes(peer, '7', [
      { endpointId: 0, clusterId: 0x33 },
      { endpointId: 1, clusterId: 0x2f },
    ])
    expect(reports).toEqual([
      { nodeId: '7', endpointId: 0, clusterId: 0x33, attributeId: 2, value: 3600 },
    ])
    const request = seen[0]
    expect(request).toMatchObject({
      attributeRequests: [
        { endpointId: 0, clusterId: 0x33 },
        { endpointId: 1, clusterId: 0x2f },
      ],
    })
  })

  it('rejects when the read fails, never answering with an empty list', async () => {
    const peer = {
      interaction: {
        read: () => {
          throw new Error('timeout')
        },
      },
    }
    await expect(
      readPeerAttributes(peer, '7', [{ endpointId: 0, clusterId: 0x33 }]),
    ).rejects.toThrow('timeout')
  })

  it('rejects a peer without a read', async () => {
    await expect(readPeerAttributes({}, '7', [])).rejects.toThrow(/no attribute read/)
  })
})
