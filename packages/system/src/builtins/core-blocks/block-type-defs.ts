/**
 * The declaration files a block is authored against.
 *
 * Served from the node rather than bundled into the admin UI: the graph is
 * 3.4 MB across 344 files. Served rather than hand-stubbed: a block runs with
 * the same `ctx` an addon gets, so a stub would drift from it and the editor
 * would confidently autocomplete methods that do not exist.
 *
 * The paths matter more than they look. Monaco resolves imports against the
 * extra-lib paths, so a file registered as anything other than
 * `file:///node_modules/@camstack/types/…` loads and then resolves NOTHING —
 * the failure that looks most like success, because the editor keeps working
 * and simply stops knowing anything.
 *
 * **Resolution must not use `import.meta.resolve`.** The hub loads the CJS
 * build of this package; the bundler erases `import.meta` to `{}`, so
 * `import.meta.resolve?.('@camstack/types')` is always undefined and the old
 * fallback — `process.cwd()/node_modules/@camstack/types` — wins. On a live
 * hub `cwd` is the image seed (`/opt/camstack-hub`), not the active data-root
 * closure that actually runs. That served a months-old `ConfigSelectField`
 * without `optionsFrom` while `/data/server-root/current` already had it, and
 * Monaco blocked Save on a property the runtime hydrate already understood.
 * `createRequire(import.meta.url)` survives the CJS emit (becomes
 * `createRequire(pathToFileURL(__filename))`) and walks from THIS module to
 * the sibling `@camstack/types` the process loaded.
 *
 * Beside `@camstack/types`, the editor also gets `zod` (real package `.d.ts`)
 * and a small Node ambient. Blocks are Node processes; without those, a
 * legitimate `import { z } from 'zod'` / `import net from 'node:net'` /
 * `process.env` is a Save-blocking Error even though esbuild will emit and
 * the runner will execute it.
 */

import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'

export interface BlockTypeLib {
  readonly filePath: string
  readonly content: string
}

/** Where Monaco must think `@camstack/types` lives for imports to resolve. */
const TYPES_VIRTUAL_ROOT = 'file:///node_modules/@camstack/types'
/** Where Monaco must think `zod` lives. */
const ZOD_VIRTUAL_ROOT = 'file:///node_modules/zod'
/**
 * Virtual path for the Node ambient. Monaco's Node moduleResolution looks for
 * `@types/node` under `node_modules`; a single index is enough for `node:*`
 * ambient modules declared inside it.
 */
const NODE_AMBIENT_PATH = 'file:///node_modules/@types/node/index.d.ts'

/**
 * Minimal Node surface for block authorship. Not `@types/node` — that package
 * is a build-time dep and is not in the production closure. This is enough
 * that Save is not refused for the builtins real scripts use (`process`,
 * `node:net`, `node:fs`, `node:path`, `node:http(s)`, `node:crypto`, timers).
 * Widen when a block hits a new missing name; do not paste the full DefinitelyTyped
 * tree into every getTypeDefs response.
 */
export const BLOCK_NODE_AMBIENT: string = `
declare const process: {
  env: Record<string, string | undefined>
  cwd(): string
  exit(code?: number): never
  stdout: { write(chunk: string): boolean }
  stderr: { write(chunk: string): boolean }
}

declare function setTimeout(handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown
declare function clearTimeout(handle: unknown): void
declare function setInterval(handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): unknown
declare function clearInterval(handle: unknown): void
declare function setImmediate(handler: (...args: unknown[]) => void, ...args: unknown[]): unknown
declare function clearImmediate(handle: unknown): void

declare const Buffer: {
  from(data: string | ArrayBuffer | Uint8Array, encoding?: string): Uint8Array
  concat(list: readonly Uint8Array[]): Uint8Array
  alloc(size: number): Uint8Array
  isBuffer(value: unknown): value is Uint8Array
}

declare module 'node:net' {
  export interface Socket {
    write(data: string | Uint8Array): boolean
    end(data?: string | Uint8Array): void
    destroy(): void
    on(event: string, listener: (...args: unknown[]) => void): this
    once(event: string, listener: (...args: unknown[]) => void): this
    setTimeout(ms: number, callback?: () => void): this
    remoteAddress?: string
    remotePort?: number
  }
  export interface Server {
    listen(port: number, host?: string, listeningListener?: () => void): this
    close(callback?: (err?: Error) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
    address(): { port: number; family: string; address: string } | string | null
  }
  export function createServer(connectionListener?: (socket: Socket) => void): Server
  export function connect(
    options: { host?: string; port: number } | number,
    connectionListener?: () => void,
  ): Socket
  const net: {
    createServer: typeof createServer
    connect: typeof connect
  }
  export default net
}

declare module 'node:fs' {
  const fs: Record<string, unknown>
  export default fs
}
declare module 'node:fs/promises' {
  const fs: Record<string, unknown>
  export default fs
}
declare module 'node:path' {
  const path: Record<string, unknown>
  export default path
}
declare module 'node:http' {
  const http: Record<string, unknown>
  export default http
}
declare module 'node:https' {
  const https: Record<string, unknown>
  export default https
}
declare module 'node:crypto' {
  const crypto: Record<string, unknown>
  export default crypto
}
declare module 'node:url' {
  const url: Record<string, unknown>
  export default url
}
declare module 'node:os' {
  const os: Record<string, unknown>
  export default os
}
declare module 'node:child_process' {
  const cp: Record<string, unknown>
  export default cp
}
declare module 'node:stream' {
  const stream: Record<string, unknown>
  export default stream
}
declare module 'node:buffer' {
  export { Buffer }
}
`.trim()

/**
 * Read every declaration a block editor needs: `@camstack/types`, `zod`, and
 * the Node ambient.
 *
 * Best-effort by design: a node that cannot find `@camstack/types` serves an
 * EMPTY types list (plus whatever else resolved), and the editor then registers
 * an empty lib set rather than keeping a stale one — so an author sees "no
 * types" instead of validating against a contract that has moved.
 */
export async function loadBlockTypeDefs(logger: IScopedLogger): Promise<readonly BlockTypeLib[]> {
  const out: BlockTypeLib[] = []

  const typesRoot = await resolvePackageDist('@camstack/types')
  if (typesRoot === null) {
    logger.warn('core-blocks: @camstack/types declarations not found — the editor gets no types')
  } else {
    await walkDts(typesRoot, typesRoot, TYPES_VIRTUAL_ROOT, out)
  }

  const zodRoot = await resolvePackageRoot('zod')
  if (zodRoot === null) {
    logger.warn('core-blocks: zod declarations not found — blocks that import zod will fail Monaco')
  } else {
    await walkDts(zodRoot, zodRoot, ZOD_VIRTUAL_ROOT, out)
  }

  out.push({ filePath: NODE_AMBIENT_PATH, content: BLOCK_NODE_AMBIENT })
  return out
}

/**
 * Resolve a package's directory that holds `index.d.ts` (the types dist root).
 * Exported for the test that pins createRequire-over-cwd.
 */
export async function resolveTypesDist(): Promise<string | null> {
  return resolvePackageDist('@camstack/types')
}

async function resolvePackageDist(pkg: string): Promise<string | null> {
  const root = await resolvePackageRoot(pkg)
  if (root === null) return null
  // `@camstack/types` resolves to `dist/index.js` — declarations sit beside it.
  if (await exists(path.join(root, 'index.d.ts'))) return root
  const dist = path.join(root, 'dist')
  if (await exists(path.join(dist, 'index.d.ts'))) return dist
  return null
}

async function resolvePackageRoot(pkg: string): Promise<string | null> {
  try {
    // Survives the CJS emit — see file header. Walks from THIS module to the
    // package the running closure actually loaded, not the image seed at cwd.
    const require_ = createRequire(import.meta.url)
    const entry = require_.resolve(pkg)
    return path.dirname(entry)
  } catch {
    // Fall through to the cwd guess — useful in unit tests and a bare
    // `node dist/…` without a proper package layout next to the file.
  }
  const guess = path.resolve(process.cwd(), 'node_modules', pkg)
  if (await exists(path.join(guess, 'package.json'))) return guess
  const guessDist = path.resolve(process.cwd(), 'node_modules', pkg, 'dist')
  if (await exists(path.join(guessDist, 'index.d.ts'))) return guessDist
  return null
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function walkDts(
  root: string,
  dir: string,
  virtualRoot: string,
  out: BlockTypeLib[],
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Zod ships v3 + v4 + mini trees; skip nested node_modules if any.
      if (entry.name === 'node_modules') continue
      await walkDts(root, full, virtualRoot, out)
      continue
    }
    if (!entry.name.endsWith('.d.ts')) continue
    const content = await fs.readFile(full, 'utf-8')
    const relative = path.relative(root, full).split(path.sep).join('/')
    out.push({ filePath: `${virtualRoot}/${relative}`, content })
  }
}
