/**
 * Scrub demux worker — mp4box parse of one self-contained `.m4s` off the
 * stream-broker event loop (D228). Spawned via `worker_threads` by
 * `demux-off-thread.ts`; NOT a second addon and NOT a cap call.
 *
 * Vite emits this as `dist/stream-broker/demux-worker-child.js`, a sibling
 * of the inlined `dist/stream-broker/index.js` entry.
 */

import { parentPort } from 'node:worker_threads'
import { demuxSegmentFullJs } from './segment-demux-js.js'
import type { AccessUnit } from './segment-demux.js'

function isRequest(message: unknown): message is { id: number; bytes: Uint8Array } {
  if (typeof message !== 'object' || message === null) return false
  if (!('id' in message) || !('bytes' in message)) return false
  return typeof message.id === 'number' && message.bytes instanceof Uint8Array
}

function transferListForAus(aus: readonly AccessUnit[]): ArrayBuffer[] {
  const out: ArrayBuffer[] = []
  for (const au of aus) {
    const buf = au.data.buffer
    if (buf instanceof ArrayBuffer) out.push(buf)
  }
  return out
}

async function onMessage(message: unknown): Promise<void> {
  if (!parentPort || !isRequest(message)) return
  try {
    const aus = await demuxSegmentFullJs(message.bytes)
    parentPort.postMessage({ id: message.id, ok: true, aus }, aus ? transferListForAus(aus) : [])
  } catch (err) {
    parentPort.postMessage({ id: message.id, ok: false, error: String(err) })
  }
}

if (!parentPort) {
  throw new Error('demux-worker-child must run as a worker_threads worker')
}
parentPort.on('message', (message: unknown) => {
  void onMessage(message)
})
