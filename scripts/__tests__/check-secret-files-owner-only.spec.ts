/**
 * `check-secret-files-owner-only` — a bare `0o600` is a no-op on Windows, so a
 * secret written that way (the agent's `agent.json`) is world-readable there.
 */
import { describe, expect, it } from 'vitest'
import { ALLOWED, findBareOwnerOnlyModes } from '../check-secret-files-owner-only.js'

const file = (rel: string, content: string) => [{ rel, content }]

describe('findBareOwnerOnlyModes', () => {
  it('refuses the shape agent.json used to be written with', () => {
    const found = findBareOwnerOnlyModes(
      file(
        'server/backend/src/agent/agent-http.ts',
        "fs.writeFileSync(p, json, { encoding: 'utf-8', mode: 0o600 })\nfs.chmodSync(p, 0o600)",
      ),
    )
    expect(found.map((f) => f.line)).toEqual([1, 2])
  })

  it('lets the helper and the documented exceptions through', () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(findBareOwnerOnlyModes(file(rel, 'mode: 0o600'))).toEqual([])
    }
  })

  it('ignores prose that merely names the mode', () => {
    expect(
      findBareOwnerOnlyModes(file('packages/x/src/a.ts', '// stored 0o600 on POSIX\n * 0o600')),
    ).toEqual([])
  })

  it('gives every exception a reason', () => {
    for (const reason of Object.values(ALLOWED)) expect(reason.length).toBeGreaterThan(20)
  })
})
