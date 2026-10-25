import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The mp4box parse used to run on stream-broker's event loop — the same loop
 * that forwards live RTP. D228's measured lever is a worker_threads child
 * INSIDE this addon (not a third process). These assertions pin the three
 * wiring points a refactor can silently drop: the vite entry that emits the
 * child, the URL the inlined broker module resolves (same trick as
 * decode-worker-child), and the session demux that actually calls it.
 */
const ROOT = join(__dirname, '../../../..')

describe('off-thread scrub demux wiring (D228)', () => {
  it('vite emits a sibling demux-worker-child next to stream-broker/index.js', () => {
    const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
    expect(vite).toContain("'stream-broker/demux-worker-child'")
    expect(vite).toContain('src/stream-broker/recorded/demux-worker-child.ts')
  })

  it('the client resolves ./demux-worker-child.js from the inlined stream-broker entry', () => {
    const client = readFileSync(join(__dirname, '../demux-off-thread.ts'), 'utf8')
    expect(client).toContain("new URL('./demux-worker-child.js', import.meta.url)")
  })

  it('the WebRTC session demux goes through the off-thread wrapper', () => {
    const server = readFileSync(join(__dirname, '../../webrtc/broker-webrtc-server.ts'), 'utf8')
    expect(server).toContain('demuxSegmentPreferJsOffThread')
    expect(server).not.toMatch(/demuxVideo =[\s\S]*demuxSegmentPreferJs\(/)
  })
})
