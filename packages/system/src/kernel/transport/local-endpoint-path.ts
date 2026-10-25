import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Filesystem path (POSIX) or named-pipe path (Windows) a node listens on for
 * its local addon-runners. Derived deterministically from the nodeId so a
 * parent and its children agree without extra coordination.
 */
export function localEndpointPath(nodeId: string): string {
  const safe = nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\camstack-${safe}`
  }
  return join(tmpdir(), `camstack-${safe}.sock`)
}
