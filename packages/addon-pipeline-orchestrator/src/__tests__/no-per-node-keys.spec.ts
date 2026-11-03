/**
 * `resolveGlobalStore()` projects the store (drops every `@` key) for an addon that declares a
 * `perNode` key. The orchestrator's node rows (`agentSettings@<node>`, `nodeBindings@<node>`)
 * are read through it, so the day this addon declares one the rows would vanish from the read.
 * This pins the two ways of declaring it out of the source until the read moves.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path)
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.spec.ts') ? [path] : []
  })
}

describe('the orchestrator declares no perNode setting', () => {
  it('no source declares perNode or nodeSettingsSchema', () => {
    const offenders = sources(join(__dirname, '..')).filter((file) =>
      /\bperNode\b|nodeSettingsSchema/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
