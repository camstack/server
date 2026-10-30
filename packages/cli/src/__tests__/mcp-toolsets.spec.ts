import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLSETS, parseToolsets } from '../mcp/toolsets.js'

describe('camstack mcp --toolsets', () => {
  it('defaults to setup, ops and configure; develop is opt-in', () => {
    expect(parseToolsets(undefined)).toEqual({ ok: true, toolsets: DEFAULT_TOOLSETS })
    expect(parseToolsets('  ')).toEqual({ ok: true, toolsets: DEFAULT_TOOLSETS })
    expect(DEFAULT_TOOLSETS).toEqual(['setup', 'ops', 'configure'])
  })

  it('selects exactly the named toolsets, once each', () => {
    expect(parseToolsets('develop')).toEqual({ ok: true, toolsets: ['develop'] })
    expect(parseToolsets('ops, setup,ops')).toEqual({ ok: true, toolsets: ['ops', 'setup'] })
  })

  it('refuses an unknown name instead of serving fewer tools', () => {
    const parsed = parseToolsets('setup,opss')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('opss')
  })
})
