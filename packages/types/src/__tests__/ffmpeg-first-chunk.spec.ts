/**
 * The supervisor must NOTICE the first output without EATING it.
 *
 * `FfmpegProcess` reports a child as "live" on its first stdout bytes. It used
 * to do that with `stdout.once('data', …)`, and a `data` listener puts the
 * stream in flowing mode: the chunk is delivered to whoever is listening AT
 * THAT MOMENT and is gone. The consumer attaches later — it only receives the
 * child once `startChild` has resolved, and `startChild` resolves ON live — so
 * the first chunk was always consumed by the supervisor and never by the code
 * that wanted it.
 *
 * For MPEG-TS that was invisible: the format is self-describing, and a reader
 * that misses the first packets finds its bearings at the next PAT/PMT. For FLV
 * it is fatal — the signature, the `onMetaData` tag and the AVC sequence header
 * appear exactly once, at the top. The grid served `200 OK` and zero bytes for
 * fifteen seconds (hub, 2026-09-17) because the only copy of its header had
 * been handed to a listener that threw it away.
 *
 * `once('readable')` answers the same question — is anything coming out? —
 * without switching the stream to flowing mode, so the bytes wait in the buffer
 * for the consumer that actually wants them.
 */
import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'

/** What `process.ts` does to detect first output, in isolation. */
function watchForFirstOutput(stdout: PassThrough, onLive: () => void): void {
  stdout.once('readable', () => {
    onLive()
  })
}

/** The shape that ATE the chunk, kept so the difference is a test and not a claim. */
function watchByConsuming(stdout: PassThrough, onLive: () => void): void {
  stdout.once('data', () => {
    onLive()
  })
}

async function firstChunkSeenByLateConsumer(
  watch: (stdout: PassThrough, onLive: () => void) => void,
): Promise<string> {
  const stdout = new PassThrough()
  let live = false
  watch(stdout, () => {
    live = true
  })
  stdout.write(Buffer.from('FLVheader'))
  await new Promise((resolve) => setImmediate(resolve))
  expect(live).toBe(true)

  // The consumer attaches only after the child is reported live — which is
  // exactly how `startChild` hands the child back.
  const seen: Buffer[] = []
  stdout.on('data', (chunk: Buffer) => seen.push(chunk))
  stdout.write(Buffer.from('-more'))
  await new Promise((resolve) => setImmediate(resolve))
  return Buffer.concat(seen).toString()
}

describe('first-output detection', () => {
  it('leaves the first chunk for the consumer', async () => {
    expect(await firstChunkSeenByLateConsumer(watchForFirstOutput)).toBe('FLVheader-more')
  })

  it('a data listener would have eaten it — this is the bug, pinned', async () => {
    expect(await firstChunkSeenByLateConsumer(watchByConsuming)).toBe('-more')
  })
})
