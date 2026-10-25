import { describe, expect, it } from 'vitest'
import {
  resolveServerName,
  SERVER_NAME_MAX_LENGTH,
  ServerNameSchema,
  shortHostname,
} from '../system/server-name.js'

describe('ServerNameSchema (D861)', () => {
  it('trims', () => {
    expect(ServerNameSchema.parse('  Casa Napoli ')).toBe('Casa Napoli')
  })

  it('takes 1 to 48 characters after trimming', () => {
    expect(ServerNameSchema.safeParse('a').success).toBe(true)
    expect(ServerNameSchema.safeParse('a'.repeat(SERVER_NAME_MAX_LENGTH)).success).toBe(true)
    expect(ServerNameSchema.safeParse('a'.repeat(SERVER_NAME_MAX_LENGTH + 1)).success).toBe(false)
    expect(ServerNameSchema.safeParse('   ').success).toBe(false)
    expect(ServerNameSchema.safeParse('').success).toBe(false)
  })

  it('counts the trimmed length, not the typed one', () => {
    expect(ServerNameSchema.safeParse(`  ${'a'.repeat(SERVER_NAME_MAX_LENGTH)}  `).success).toBe(
      true,
    )
  })

  it('refuses control characters, wherever they sit', () => {
    for (const bad of ['a\u0000b', 'a\nb', 'a\tb', '\u007fa', 'a\u0085b']) {
      expect(ServerNameSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('accepts ordinary non-ASCII text', () => {
    expect(ServerNameSchema.parse('Casa di Alice è qui')).toBe('Casa di Alice è qui')
  })
})

describe('resolveServerName (D861)', () => {
  it('unset falls back to the hostname without its domain, flagged', () => {
    expect(resolveServerName(undefined, 'nas.lan.example')).toEqual({
      name: 'nas',
      isDefault: true,
    })
  })

  it('a valid stored name wins', () => {
    expect(resolveServerName('Casa', 'nas')).toEqual({ name: 'Casa', isDefault: false })
  })

  it('an unusable hostname falls back to CamStack, still flagged default', () => {
    for (const host of ['', '.local', 'localhost', 'localhost.localdomain']) {
      expect(shortHostname(host)).toBe('CamStack')
      expect(resolveServerName(undefined, host)).toEqual({ name: 'CamStack', isDefault: true })
    }
  })

  it('a 12-hex container id falls back to CamStack', () => {
    expect(resolveServerName(undefined, 'a4afbe756e45')).toEqual({
      name: 'CamStack',
      isDefault: true,
    })
  })

  it('a 64-hex container id falls back to CamStack', () => {
    expect(resolveServerName(undefined, 'a1b2c3d4e5f60718'.repeat(4))).toEqual({
      name: 'CamStack',
      isDefault: true,
    })
  })

  it('a real hostname is kept, domain stripped; near-misses of an id are kept', () => {
    expect(shortHostname('nas.lan.example')).toBe('nas')
    expect(shortHostname('deadbeef')).toBe('deadbeef')
    expect(shortHostname('a4afbe756e4')).toBe('a4afbe756e4')
    expect(shortHostname('a4afbe756e4g')).toBe('a4afbe756e4g')
  })
})
