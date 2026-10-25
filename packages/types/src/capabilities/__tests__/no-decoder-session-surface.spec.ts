import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EventCategory } from '../../enums/event-category.js'
import * as decoderCap from '../decoder.cap.js'
import * as capabilities from '../index.js'
import * as streamingShared from '../schemas/streaming-shared.js'

/**
 * The `decoder` cap's session surface is removed (D763). Its only in-repo
 * caller was the stream broker's frame-handle plane (D762); decoding runs in
 * the pipeline runner's session-decode workers, which use node-av directly.
 * On the live cluster `decoder.listActiveSessions` was `[]` on every node.
 * What stays is what is still called: `getInfo` (the per-node hwaccel read of
 * the orchestrator, the broker's egress and HomeKit) and `reprobeHwaccel`
 * (the settings panel's re-probe action).
 */
const KEPT_METHODS = ['getInfo', 'reprobeHwaccel']

const MONOREPO_ROOT = resolve(__dirname, '../../../../..')

describe('the decoder cap has no session surface (D763)', () => {
  it('exposes only getInfo and reprobeHwaccel', () => {
    expect(Object.keys(decoderCap.decoderCapability.methods).toSorted()).toEqual(KEPT_METHODS)
  })

  it('getInfo reports no session mode or provider priority', () => {
    const shape = decoderCap.decoderCapability.methods.getInfo.output.shape
    expect(Object.keys(shape)).not.toContain('isPullMode')
    expect(Object.keys(shape)).not.toContain('priority')
  })

  it('no session, packet, frame or shm-ring schema is exported', () => {
    const exported = [
      ...Object.keys(capabilities),
      ...Object.keys(decoderCap),
      ...Object.keys(streamingShared),
    ].filter((k) =>
      /^(ShmRingStats|DecoderSessionConfig|DecoderStats|EncodedPacket|DecodedFrame)Schema$/.test(k),
    )
    expect(exported).toEqual([])
  })

  it('the hwaccel-changed event, with neither emitter nor subscriber, is gone', () => {
    expect(Object.values(EventCategory)).not.toContain('pipeline.agent-hwaccel-changed')
  })

  it('the shm-ring package and the ffmpeg decoder addon stay deleted', () => {
    expect(existsSync(resolve(MONOREPO_ROOT, 'packages/shm-ring'))).toBe(false)
    expect(existsSync(resolve(MONOREPO_ROOT, 'packages/addon-decoder-ffmpeg'))).toBe(false)
  })
})
