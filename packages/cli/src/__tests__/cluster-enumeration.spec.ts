import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `--cluster` must never quietly deploy to fewer nodes than it claims.
 *
 * On 2026-08-02 `camstack deploy --cluster` printed "no online agents found,
 * pushing to hub only" while `agent-a` was alive, logging, and happily
 * accepting the same tarball via `-n agent-a`. The cause was not the
 * agent:
 *
 *   input `{"json":null}` -> HTTP 200 + { error: "expected object" }
 *   input `{"json":{}}`   -> HTTP 200 + three nodes, all online
 *
 * tRPC answers an input-validation failure with **200** and an `error` in the
 * body. The old code read `body.result?.data?.json ?? []`, so that error became
 * an empty cluster and the deploy reported success. A partial update that says
 * it worked is worse than one that fails: the fleet silently splits across
 * versions, which is how an agent ended up a day behind on framework code.
 *
 * Source-level assertions on purpose — the failure was in what the CLI SENDS
 * and how it reads the reply, and neither is reachable without a live hub.
 */
const DEPLOY_SRC = readFileSync(join(process.cwd(), 'src', 'commands', 'deploy.ts'), 'utf8')

describe('cluster enumeration cannot silently report an empty fleet', () => {
  it('sends an OBJECT input, not null', () => {
    expect(DEPLOY_SRC).toContain('{"json":{}}')
    expect(DEPLOY_SRC).not.toContain('{"json":null}')
  })

  it('treats a 200 carrying an `error` as a failure', () => {
    // The whole class of bug: HTTP-ok plus a body-level error, silently
    // coalesced to a default by optional chaining.
    expect(DEPLOY_SRC).toContain('if (body.error)')
    expect(DEPLOY_SRC).toContain('nodes.topology failed')
  })

  it('refuses to assume an empty cluster when the list is missing', () => {
    expect(DEPLOY_SRC).toContain('refusing to assume the cluster is empty')
  })

  it('aborts instead of falling back to a hub-only deploy', () => {
    // "falling back to hub only" was the line that made a partial fleet update
    // look like a completed one.
    expect(DEPLOY_SRC).not.toContain('falling back to hub only')
    expect(DEPLOY_SRC).toContain('refusing a partial cluster deploy')
  })
})
