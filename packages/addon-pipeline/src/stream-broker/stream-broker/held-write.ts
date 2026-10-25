/**
 * The one way a broker packet is written to a socket (D868).
 *
 * A `socket.write(chunk)` that cannot go out at once is QUEUED by Node, holding
 * the chunk (and, once handed to libuv, a raw pointer into its memory) for as
 * long as the peer takes to drain: seconds for a recorder or a LAN decoder
 * behind a full kernel buffer. A packet is a view of a recycled slab
 * (`slab-pool.ts`), so the write must hold it until Node reports the write
 * finished; the callback also fires on error and on destroy, so the hold is
 * never leaked.
 *
 * `scripts/check-slab-writes-held.ts` fails any other `.write(` of a packet in
 * `stream-broker/**`.
 */
import type { Writable } from 'node:stream'
import { holdPacket, releasePacket } from './slab-pool.js'

/** Write `payload`, holding its slab until the write completes (or fails). */
export function writeHeld(sink: Writable, payload: Buffer): boolean {
  holdPacket(payload)
  return sink.write(payload, () => releasePacket(payload))
}
