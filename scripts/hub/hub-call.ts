/**
 * One call on the hub's tRPC API from an operator script, through `hub.mjs`.
 *
 * Shared by the operator scripts under `scripts/hub/` (it outlived the D870
 * device-store migration it was written for).
 */
import { spawn } from 'node:child_process'
import * as path from 'node:path'

/** A call on the hub's tRPC API. */
export interface HubCall {
  query(route: string, input: unknown): Promise<unknown>
  mutate(route: string, input: unknown): Promise<unknown>
}

/**
 * How one call reaches hub.mjs: the argv and what goes on stdin. NO input at all
 * when there is none - a route whose input is optional rejects an explicit
 * `null` (`addons.list`, `streamBroker.listAllProfileSlots`) - and never the JSON
 * on argv, which has a size limit.
 */
export function hubInvocation(
  extra: readonly string[],
  method: 'GET' | 'POST',
  route: string,
  input: unknown,
): { readonly args: readonly string[]; readonly stdin: string | undefined } {
  const withInput = input !== undefined
  return {
    args: [...extra, method, route, ...(withInput ? ['-'] : [])],
    stdin: withInput ? JSON.stringify(input) : undefined,
  }
}

/** The real hub, through hub.mjs; the input goes on STDIN (argv has a size limit). */
export function hubMjsCall(server: string, tokenFile: string | null): HubCall {
  const script = path.join(import.meta.dirname ?? __dirname, 'hub.mjs')
  const extra = ['--server', server, ...(tokenFile === null ? [] : ['--token-file', tokenFile])]
  const call = (method: 'GET' | 'POST', route: string, input: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const { args, stdin } = hubInvocation(extra, method, route, input)
      const child = spawn('node', [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (c: Buffer) => out.push(c))
      child.stderr.on('data', (c: Buffer) => err.push(c))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(Buffer.concat(err).toString('utf-8').trim() || `hub.mjs exited ${code}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(out).toString('utf-8')) as unknown)
        } catch (e: unknown) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
      child.stdin.end(stdin)
    })
  return {
    query: (route, input) => call('GET', route, input),
    mutate: (route, input) => call('POST', route, input),
  }
}
