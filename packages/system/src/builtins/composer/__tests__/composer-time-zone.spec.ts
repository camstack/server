import { afterEach, describe, expect, it } from 'vitest'
import { recordingLogger } from './fixtures.js'
import { resolveComposerTimeZone } from '../composer.js'

describe('resolveComposerTimeZone', () => {
  const original = process.env['TZ']
  afterEach(() => {
    if (original === undefined) delete process.env['TZ']
    else process.env['TZ'] = original
  })

  it('keeps a configured zone', () => {
    expect(resolveComposerTimeZone('Europe/Rome', recordingLogger().logger)).toBe('Europe/Rome')
  })

  it('falls back to UTC when the process zone is Etc/Unknown (empty TZ)', () => {
    process.env['TZ'] = ''
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Etc/Unknown')
    const zone = resolveComposerTimeZone(undefined, recordingLogger().logger)
    expect(zone).toBe('UTC')
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone })).not.toThrow()
  })
})
