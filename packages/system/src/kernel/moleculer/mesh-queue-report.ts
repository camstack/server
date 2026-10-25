/**
 * mesh-queue-report — the write queue of every Moleculer TCP socket this
 * process holds to a peer node, on the `[mem]` line (D446).
 *
 * ## Why a separate reader
 *
 * The UDS plane is measured on the channel (`SocketChannel.queuedBytes`). The
 * mesh plane is Moleculer's: `TcpTransporter.writer` is a `TcpWriter` whose
 * `sockets` map holds one `net.Socket` per peer node, opened lazily on the
 * first send and — this is the point — `unref()`'d at connect
 * (`transporters/tcp/tcp-writer.js`). An unref'd handle is not in
 * `process._getActiveHandles()`, so the 2026-09-10 census that summed
 * `writableLength` over that list and excluded "every socket queue" could not
 * have seen a backlog to an agent, however large.
 *
 * ## What is read, and how carefully
 *
 * `broker.transit.tx.writer.sockets` — an internal path, walked with type
 * guards and never a cast. Every step that is not the expected shape yields
 * `undefined` for the WHOLE reading: a test broker (`Fake` transporter), a
 * broker that does not exist yet, a Moleculer whose internals moved. `undefined`
 * is "this process has no mesh writer to report", never "the mesh is quiet".
 * A socket entry without numeric `writableLength`/`bytesWritten` is skipped
 * on its own.
 */

/** One peer node's outbound socket, as the writer holds it. */
export interface MeshPeerQueue {
  readonly nodeId: string
  /** Bytes handed to the socket that the kernel has not taken yet. */
  readonly queuedBytes: number
  /** Lifetime bytes written on this socket — so a stalled queue can be read
   *  against the peer's normal rate. */
  readonly bytesWritten: number
}

/** `undefined` = no mesh writer to report (no broker, `Fake` transporter). */
export type MeshQueueReader = () => readonly MeshPeerQueue[] | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The shape `TcpWriter` keeps its sockets in. Anything else is not a mesh. */
function writerSocketsOf(broker: unknown): ReadonlyMap<unknown, unknown> | undefined {
  if (!isRecord(broker)) return undefined
  const transit = broker['transit']
  if (!isRecord(transit)) return undefined
  const transporter = transit['tx']
  if (!isRecord(transporter)) return undefined
  const writer = transporter['writer']
  if (!isRecord(writer)) return undefined
  const sockets = writer['sockets']
  return sockets instanceof Map ? sockets : undefined
}

function readSocket(nodeId: unknown, socket: unknown): MeshPeerQueue | undefined {
  if (typeof nodeId !== 'string' || !isRecord(socket)) return undefined
  const queuedBytes = socket['writableLength']
  const bytesWritten = socket['bytesWritten']
  if (typeof queuedBytes !== 'number' || typeof bytesWritten !== 'number') return undefined
  return { nodeId, queuedBytes, bytesWritten }
}

/**
 * Build a reader over a lazily-resolved broker. Wrapped: a broker mid-teardown
 * may throw, and a diagnostic that can crash the process it watches is worse
 * than none.
 */
export function createMeshQueueReader(getBroker: () => unknown): MeshQueueReader {
  return (): readonly MeshPeerQueue[] | undefined => {
    try {
      const sockets = writerSocketsOf(getBroker())
      if (sockets === undefined) return undefined
      const peers: MeshPeerQueue[] = []
      for (const [nodeId, socket] of sockets) {
        const peer = readSocket(nodeId, socket)
        if (peer !== undefined) peers.push(peer)
      }
      return peers
    } catch {
      return undefined
    }
  }
}

/** At most this many nodes named. A cluster has a handful. */
export const MESH_QUEUE_TOP_N = 3

function kb(bytes: number): number {
  return Math.round(bytes / 1024)
}

/**
 * The suffix appended to a `[mem]` line — leading space included, empty when
 * this process has no mesh writer. `meshQueued` is printed always, at zero
 * included: a quiet mesh is a reading. `meshQueuedTop` names only nodes with
 * a queue, largest first — a ranked list of zeros is noise.
 */
export function formatMeshQueue(peers: readonly MeshPeerQueue[] | undefined): string {
  if (peers === undefined) return ''
  const total = peers.reduce((sum, p) => sum + p.queuedBytes, 0)
  const top = peers
    .filter((p) => p.queuedBytes > 0)
    .toSorted((a, b) => b.queuedBytes - a.queuedBytes || a.nodeId.localeCompare(b.nodeId))
    .slice(0, MESH_QUEUE_TOP_N)
    .map((p) => `${p.nodeId}:${kb(p.queuedBytes)}`)
    .join(',')
  return ` meshQueued=${kb(total)}kB` + (top.length === 0 ? '' : ` meshQueuedTop=${top}`)
}
