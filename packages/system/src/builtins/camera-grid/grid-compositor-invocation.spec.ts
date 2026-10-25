/**
 * The two argv the compositor spawns, pinned.
 *
 * Both come from the shared builder in `@camstack/types` — this addon builds no
 * argv of its own (`scripts/check-ffmpeg-primitive.ts`, Rule 1). What this
 * suite protects is the two decisions that are NOT the builder's: a tile pays
 * no codec on the way out, and the encoder never decodes.
 */
import { describe, expect, it } from 'vitest'
import { buildFfmpegArgs } from '@camstack/types'
import {
  gridCanvasEncoderInvocation,
  gridTileDecoderInvocation,
} from './grid-compositor-invocation.js'

const TILE = {
  id: 'cell-0',
  deviceId: 107,
  size: { width: 960, height: 540 },
  origin: { x: 0, y: 0 },
  frameBytes: (960 * 540 * 3) / 2,
  filter: 'scale=960:540,format=yuv420p',
}

describe('the tile decoder', () => {
  const args = buildFfmpegArgs(
    gridTileDecoderInvocation({ tile: TILE, url: 'rtsp://127.0.0.1:8554/a/muted', fps: 10 }),
  )

  it('pays no codec on the way out — the canvas wants pixels, not a stream', () => {
    expect(args[args.indexOf('-c:v') + 1]).toBe('rawvideo')
    expect(args.slice(-3)).toEqual(['-f', 'rawvideo', 'pipe:1'])
  })

  it('emits the cell filter, and the format the canvas is in', () => {
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=960:540,format=yuv420p')
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p')
  })

  it('opens from the SDP, not by reading media (D527)', () => {
    const probe = args.indexOf('-analyzeduration')
    expect(args[probe + 1]).toBe('0')
    expect(args[args.indexOf('-probesize') + 1]).toBe('32')
    expect(probe).toBeLessThan(args.indexOf('-i'))
  })

  it('takes no audio — a tile is a picture', () => {
    expect(args).toContain('-an')
  })
})

describe('the canvas encoder', () => {
  const args = buildFfmpegArgs(
    gridCanvasEncoderInvocation({
      canvas: { width: 1920, height: 1080 },
      fps: 10,
      encoder: 'libx264',
      bitrateKbps: 3000,
    }),
  )

  it('reads raw frames on stdin, and is TOLD what they are', () => {
    expect(args.slice(args.indexOf('-f'), args.indexOf('-i') + 2)).toEqual([
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      '-video_size',
      '1920x1080',
      '-framerate',
      '10',
      '-i',
      'pipe:0',
    ])
  })

  it('keeps the measured latency settings of the child it replaces', () => {
    // Without `zerolatency` about four seconds of picture sat inside the
    // encoder — the operator reported it as "ritardi di secondi".
    expect(args[args.indexOf('-tune') + 1]).toBe('zerolatency')
    // One-second GOP: the worst case a consumer waits before a grid appears.
    expect(args[args.indexOf('-g') + 1]).toBe('10')
  })

  it("writes FLV, because the broker's reader SEGFAULTS on MPEG-TS", () => {
    expect(args.slice(-3)).toEqual(['-f', 'flv', 'pipe:1'])
  })
})

describe('threads, because the pid ceiling is what actually broke', () => {
  it('bounds the DECODER, before -i, not only the encoder after it', () => {
    // `threadCount` lands after the video args and bounds the ENCODER. A tile
    // with only that set still carried min(cores,16) decoder frame threads and
    // a filter pool: 72 threads measured. All three together measure 26.
    const args = buildFfmpegArgs(
      gridTileDecoderInvocation({ tile: TILE, url: 'rtsp://127.0.0.1:8554/a/muted', fps: 10 }),
    )
    const first = args.indexOf('-threads')
    expect(args[first + 1]).toBe('1')
    expect(first).toBeLessThan(args.indexOf('-i'))
    expect(args[args.indexOf('-filter_threads') + 1]).toBe('1')
  })

  it('gives the encoder a few, because it is the only piece that scales with the canvas', () => {
    const args = buildFfmpegArgs(
      gridCanvasEncoderInvocation({
        canvas: { width: 1920, height: 1080 },
        fps: 10,
        encoder: 'libx264',
        bitrateKbps: 3000,
      }),
    )
    expect(args[args.indexOf('-threads') + 1]).toBe('4')
  })

  it('never leaves either child on AUTO', () => {
    // Auto is one thread per core, per child, and a compositor has N+1 of them:
    // two tiles reading 640x360 held 71 and 56 threads against a 2048 pid
    // ceiling the container was already 91% into.
    for (const args of [
      buildFfmpegArgs(gridTileDecoderInvocation({ tile: TILE, url: 'rtsp://x/muted', fps: 10 })),
      buildFfmpegArgs(
        gridCanvasEncoderInvocation({
          canvas: { width: 640, height: 360 },
          fps: 10,
          encoder: 'libx264',
          bitrateKbps: 800,
        }),
      ),
    ]) {
      expect(args).toContain('-threads')
    }
  })
})
