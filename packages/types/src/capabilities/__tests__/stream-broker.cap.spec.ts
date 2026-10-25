import { describe, it, expect } from 'vitest'
import { streamBrokerCapability } from '../stream-broker.cap.js'

describe('streamBrokerCapability.publishCameraStream', () => {
  it('accepts kind: "derived" with sourceCamStreamId + encodeProfile', () => {
    const input = streamBrokerCapability.methods.publishCameraStream.input
    const parsed = input.safeParse({
      deviceId: 99,
      camStreamId: 'derived:web-720p',
      kind: 'derived',
      sourceCamStreamId: 'native:main',
      encodeProfile: {
        video: { codec: 'h264', width: 1280, height: 720, fps: 25, bitrateKbps: 3000 },
        audio: 'passthrough',
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts kind: "derived" with no optional fields (runtime validation handles the requirement)', () => {
    // The schema is permissive: sourceCamStreamId and encodeProfile are optional
    // at the Zod level. The broker manager (Task 10) enforces that both are
    // present when kind === 'derived' at runtime. This keeps ts-morph able to
    // emit the full field types in addon-api.ts instead of collapsing to
    // ZodEffects / [x: string]: unknown.
    const input = streamBrokerCapability.methods.publishCameraStream.input
    const parsed = input.safeParse({
      deviceId: 99,
      camStreamId: 'derived:web-720p',
      kind: 'derived',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts the existing native kind without sourceCamStreamId', () => {
    const input = streamBrokerCapability.methods.publishCameraStream.input
    const parsed = input.safeParse({
      deviceId: 99,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://example.com/stream',
    })
    expect(parsed.success).toBe(true)
  })
})
