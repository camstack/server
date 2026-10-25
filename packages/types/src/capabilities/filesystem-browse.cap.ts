/**
 * filesystem-browse — per-node capability for browsing the node's local
 * filesystem. Reads are unconfined (whole filesystem, from `/` down); WRITES
 * are sandboxed to operator-configured allowed roots (D115). Used by the
 * admin "Add filesystem location" flow to pick a node + path. `mode:'per-node'`
 * (one provider per node); the hub calls it with `{nodeId}` so the codegen
 * routes to that exact node (default `nodeIdMode:'routing'`).
 */
import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

const DirEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
})

const BrowseResultSchema = z.object({
  path: z.string(),
  entries: z.array(DirEntrySchema).readonly(),
  freeBytes: z.number(),
  totalBytes: z.number(),
})

export const filesystemBrowseCapability = {
  name: 'filesystem-browse',
  scope: 'system',
  // `singleton` + node-routing: every node hosts its own provider; the hub
  // call carries `{nodeId}` and the cap-router routes to that node via
  // `createRemoteProxy` (same pattern as `platform-probe`). The codegen's
  // ALL_CAPABILITY_DEFINITIONS map only matches singleton/collection, and
  // `per-node` is not an actually-wired runtime mode — singleton is correct.
  mode: 'singleton',
  internal: true,
  methods: {
    /** The roots `createDir` is sandboxed to on this node. Browsing is not confined to them. */
    listAllowedRoots: method(z.void(), z.array(z.string()).readonly(), { auth: 'admin' }),
    /** Immediate subdirectories of any absolute `path` + free/total bytes. Read-only. */
    browse: method(z.object({ path: z.string() }), BrowseResultSchema, { auth: 'admin' }),
    /** Create a subdirectory (within an allowed root). Returns its absolute path. */
    createDir: method(z.object({ path: z.string() }), z.object({ path: z.string() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IFilesystemBrowseProvider = InferProvider<typeof filesystemBrowseCapability>
