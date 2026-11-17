import { describe, expect, it } from 'vitest'
import { classifyIdentityMatch } from '../device-identity-index.js'

const mac = { key: 'mac', value: 'aa:bb:cc:00:11:22' } as const
const mac2 = { key: 'mac', value: '00:11:22:33:44:55' } as const
const serial = { key: 'serial', value: 'hikvision:ds-123' } as const
const ip = { key: 'ip', value: '192.0.2.10' } as const
const hostname = { key: 'hostname', value: 'cam-1' } as const

describe('classifyIdentityMatch — the pair rule (planning#593)', () => {
  it('two strong kinds → auto', () => {
    expect(classifyIdentityMatch([mac, serial])).toBe('auto')
  })
  it('MAC plus IP → auto', () => {
    expect(classifyIdentityMatch([mac, ip])).toBe('auto')
  })
  it('exactly one strong kind → proposal, however many values of it', () => {
    expect(classifyIdentityMatch([serial])).toBe('proposal')
    expect(classifyIdentityMatch([mac, mac2])).toBe('proposal')
    expect(classifyIdentityMatch([serial, ip])).toBe('proposal')
    expect(classifyIdentityMatch([serial, hostname])).toBe('proposal')
  })
  it('weak keys alone, or nothing, → no candidate', () => {
    expect(classifyIdentityMatch([ip, hostname])).toBeNull()
    expect(classifyIdentityMatch([])).toBeNull()
  })
})
