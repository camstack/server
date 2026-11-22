import { describe, expect, it } from 'vitest'
import { resolveInvocation } from '../help-routing.js'

const commands = [{ name: 'deploy', aliases: ['push'] }, { name: 'mcp' }] as const

describe('resolveInvocation — every command answers --help', () => {
  it('answers <cmd> --help and <cmd> <sub> --help with that command help', () => {
    expect(resolveInvocation(['deploy', '--help'], commands)).toEqual({
      kind: 'command-help',
      command: commands[0],
    })
    expect(resolveInvocation(['mcp', 'doctor', '-h'], commands)).toEqual({
      kind: 'command-help',
      command: commands[1],
    })
  })
  it('answers --help <cmd>, help <cmd> and an alias', () => {
    expect(resolveInvocation(['--help', 'deploy'], commands).kind).toBe('command-help')
    expect(resolveInvocation(['help', 'push'], commands).kind).toBe('command-help')
  })
  it('keeps bare help global, an unknown name unknown, and a plain call a run', () => {
    expect(resolveInvocation(['--help'], commands).kind).toBe('global-help')
    expect(resolveInvocation(['help'], commands).kind).toBe('global-help')
    expect(resolveInvocation(['nope'], commands)).toEqual({ kind: 'unknown', name: 'nope' })
    expect(resolveInvocation(['deploy', 'x'], commands)).toMatchObject({ kind: 'run', args: ['x'] })
  })
})
