/**
 * Every UDS parent the server builds — the hub's (`moleculer.service.ts`) and
 * the agent's (`agent/main.ts`) — hands its `LocalChildRegistry` the node's
 * kernel bus as `lifecycleEvents`. A forked runner has no Moleculer broker, so
 * that registry is the ONLY source of `WorkerOnline` / `WorkerOffline` for one;
 * a parent built without it silences them for every runner it hosts, and the
 * orchestrator's D696 provider gate then never sees a provider roll back
 * (2026-10-02 motion-release-order fix round 1, review C1).
 *
 * The registry's own emission is proved over a real socket in
 * `packages/system/src/kernel/__tests__/transport/child-lifecycle-events.spec.ts`,
 * and through the orchestrator in `camera-sensors-acceptance.spec.ts` #22–#23.
 * This pins the wiring, which only a full broker start would otherwise reach.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '..')

function productionSources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      out.push(...productionSources(full))
    } else if (name.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

/** The object literal handed to each `new LocalChildRegistry({ … })`, by balanced braces. */
function registryOptionLiterals(code: string): string[] {
  const out: string[] = []
  const marker = 'new LocalChildRegistry({'
  let at = code.indexOf(marker)
  while (at !== -1) {
    let depth = 0
    let end = at + marker.length - 1
    for (; end < code.length; end += 1) {
      const ch = code[end]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    out.push(code.slice(at, end + 1))
    at = code.indexOf(marker, end)
  }
  return out
}

describe('every server UDS parent emits runner lifecycle events', () => {
  const sites = productionSources(SRC).flatMap((file) =>
    registryOptionLiterals(readFileSync(file, 'utf-8')).map((literal) => ({
      file: path.relative(SRC, file),
      literal,
    })),
  )

  it('finds the hub`s and the agent`s registry', () => {
    expect(sites.map((s) => s.file).toSorted()).toEqual([
      'agent/main.ts',
      'core/moleculer/moleculer.service.ts',
    ])
  })

  it.each(
    sites.map((s) => [s.file, s.literal] as const),
  )('%s passes lifecycleEvents', (_file, literal) => {
    expect(literal).toMatch(/\blifecycleEvents\s*:/)
  })
})
