/**
 * P2c — `RunnerCameraConfigSchema.frameSource` (cross-node pipeline Phase 2,
 * restream-owner design §2.4 step 4).
 *
 * The orchestrator tells each runner PER CAMERA where its decoded frames come
 * from:
 *  - `local-broker` (DEFAULT): today's path — subscribe to the co-located
 *    stream-broker's shm frame plane. Every pre-P2c attach payload (which has
 *    no `frameSource` at all) MUST parse to this — the additive-default
 *    safety invariant.
 *  - `remote-restream`: the detect node is NOT the camera's source-owner —
 *    acquire the owner's compressed restream (`getStreamWithCodec`,
 *    video:'copy') and decode LOCALLY via a satellite frame plane +
 *    pull-mode decoder session.
 */
import { describe, expect, it } from 'vitest'
import { RunnerCameraConfigSchema } from '../capabilities/pipeline-runner.cap.js'

/** A minimal valid pre-P2c attach payload (no `frameSource` key at all). */
function legacyAttachPayload(): Record<string, unknown> {
  return {
    deviceId: 104,
    motionStreamId: 'sub',
    detectionStreamId: 'main',
  }
}

describe('RunnerCameraConfigSchema.frameSource (P2c)', () => {
  it('defaults to local-broker when absent — pre-P2c payloads are unchanged', () => {
    const parsed = RunnerCameraConfigSchema.parse(legacyAttachPayload())
    expect(parsed.frameSource).toEqual({ kind: 'local-broker' })
  })

  it('accepts an explicit local-broker', () => {
    const parsed = RunnerCameraConfigSchema.parse({
      ...legacyAttachPayload(),
      frameSource: { kind: 'local-broker' },
    })
    expect(parsed.frameSource).toEqual({ kind: 'local-broker' })
  })

  it('accepts remote-restream with the owner node id', () => {
    const parsed = RunnerCameraConfigSchema.parse({
      ...legacyAttachPayload(),
      frameSource: { kind: 'remote-restream', ownerNodeId: 'hub' },
    })
    expect(parsed.frameSource).toEqual({ kind: 'remote-restream', ownerNodeId: 'hub' })
  })

  it('accepts remote-restream with an operator hostname override', () => {
    const parsed = RunnerCameraConfigSchema.parse({
      ...legacyAttachPayload(),
      frameSource: {
        kind: 'remote-restream',
        ownerNodeId: 'hub',
        hubHostnameOverride: '192.168.10.9',
      },
    })
    expect(parsed.frameSource).toEqual({
      kind: 'remote-restream',
      ownerNodeId: 'hub',
      hubHostnameOverride: '192.168.10.9',
    })
  })

  it('rejects remote-restream without ownerNodeId', () => {
    expect(() =>
      RunnerCameraConfigSchema.parse({
        ...legacyAttachPayload(),
        frameSource: { kind: 'remote-restream' },
      }),
    ).toThrow()
  })

  it('rejects an unknown kind', () => {
    expect(() =>
      RunnerCameraConfigSchema.parse({
        ...legacyAttachPayload(),
        frameSource: { kind: 'shm-teleport' },
      }),
    ).toThrow()
  })
})
