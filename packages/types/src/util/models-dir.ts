import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

/**
 * The shared, node-local models directory: `<nodeDataDir>/models`, created when missing.
 *
 * The SINGLE resolver for every inference addon (detection-pipeline, audio-analyzer,
 * embedding-encoder, model-studio, ai). It is anchored at the node's own writable data root
 * (`ctx.nodeDataDir`) — never the hub-singleton `storage` cap, which returns the hub's
 * `/data/models` to every node and breaks a node whose real data dir differs (the macOS agent).
 * Node-only, hence `@dominevo/types/node`, off the browser-facing root entry.
 */
export async function resolveModelsDir(nodeDataDir: string): Promise<string> {
  const dir = join(nodeDataDir, 'models')
  await fsp.mkdir(dir, { recursive: true })
  return dir
}
