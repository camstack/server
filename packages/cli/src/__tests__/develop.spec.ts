import { describe, expect, it } from 'vitest'
import { developHelp, peekCapability } from '../commands/develop.js'

describe('camstack develop', () => {
  it('exposes help text with core subcommands', () => {
    const help = developHelp()
    expect(help).toContain('list-addons')
    expect(help).toContain('scaffold addon')
    expect(help).toContain('find-example')
    expect(help).toContain('validate')
  })

  it('can resolve a known capability from the workspace', () => {
    expect(peekCapability('smtp-provider')).toBe('smtp-provider')
  })
})
