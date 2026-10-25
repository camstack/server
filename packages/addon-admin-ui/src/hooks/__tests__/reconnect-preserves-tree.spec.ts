/**
 * Watchdog reconnect must call System.reconnect() on the live singleton —
 * not resetSystem() — so useBootGate does not re-arm and open dialogs stay
 * mounted after a ≥30s background tab.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(path.resolve(HERE, '../../App.tsx'), 'utf8')

describe('AppShell watchdog reconnect', () => {
  it('reconnects the live System instead of resetting the singleton', () => {
    const start = APP.indexOf('const rebuildSocket')
    expect(start).toBeGreaterThan(0)
    const reconnectBlock = APP.slice(start, start + 800)
    expect(reconnectBlock).toContain('getSystem().reconnect()')
    // A call would be its own statement; the comment may still name resetSystem.
    expect(reconnectBlock).not.toMatch(/^\s*resetSystem\(\)/m)
  })
})
