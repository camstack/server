/**
 * Matrix tests for `checkScopeAccess`. Drives the scope-gate in
 * `protectedProcedure`.
 *
 * The map (`METHOD_ACCESS_MAP`) is codegen-emitted; the test imports
 * it indirectly via the helper so any drift between cap definitions
 * and runtime would surface here as a test failure (e.g. a renamed
 * method would no longer resolve to a known entry).
 */
import { describe, it, expect } from 'vitest'
import { checkScopeAccess } from '../scope-access.js'
import type { TokenScope } from '@camstack/types'

function scope(
  type: 'addon' | 'capability',
  target: string,
  access: Extract<TokenScope, { type: 'addon' }>['access'],
): TokenScope {
  return { type, target, access }
}

describe('checkScopeAccess', () => {
  // ── Sanity: known paths resolve, unknown paths fail closed ──────

  it('returns FORBIDDEN with codegen-drift reason for unknown paths', () => {
    const result = checkScopeAccess([scope('capability', 'backup', ['view'])], 'no-such.method')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('codegen drift')
    }
  })

  // ── Capability-typed scopes ─────────────────────────────────────

  it('accepts when capability scope matches target + access', () => {
    const result = checkScopeAccess([scope('capability', 'backup', ['view'])], 'backup.list')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.access).toBe('view')
  })

  it('rejects when capability scope matches target but lacks the required access', () => {
    // backup.trigger requires `create`; the scope only grants `view`.
    const result = checkScopeAccess([scope('capability', 'backup', ['view'])], 'backup.trigger')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Matcher's reason format: "No scope grants <access> on '<cap>' (<scope>-scope cap)"
      expect(result.reason).toMatch(/No scope grants create on 'backup'/)
    }
  })

  it('rejects when capability scope targets a different cap entirely', () => {
    const result = checkScopeAccess(
      [scope('capability', 'devices', ['view', 'create', 'delete'])],
      'backup.list',
    )
    expect(result.ok).toBe(false)
  })

  it('accepts destructive method when scope includes delete', () => {
    const result = checkScopeAccess(
      [scope('capability', 'backup', ['view', 'delete'])],
      'backup.delete',
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.access).toBe('delete')
  })

  // ── Scope unions ────────────────────────────────────────────────

  it('union of access flavours satisfies any single requirement', () => {
    const scopes: TokenScope[] = [
      scope('capability', 'backup', ['view']),
      scope('capability', 'backup', ['create']),
    ]
    // view request → first scope matches
    expect(checkScopeAccess(scopes, 'backup.list').ok).toBe(true)
    // create request → second scope matches
    expect(checkScopeAccess(scopes, 'backup.trigger').ok).toBe(true)
  })

  // ── Empty scope set ─────────────────────────────────────────────

  it('rejects when no scopes are granted at all', () => {
    const result = checkScopeAccess([], 'backup.list')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('Have: (none)')
    }
  })

  // ── Reason string contains debug-friendly diff ──────────────────

  it('reason string surfaces what the caller actually has', () => {
    const result = checkScopeAccess([scope('capability', 'devices', ['view'])], 'backup.trigger')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Format: "No scope grants create on 'backup' (system-scope cap). Have: capability:devices[view]"
      expect(result.reason).toMatch(/No scope grants create on 'backup'/)
      expect(result.reason).toContain('capability:devices[view]')
    }
  })
})
