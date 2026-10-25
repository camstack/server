/**
 * The room's same-location SUGGESTIONS belong to the Linked devices table
 * alone (D356: a link is what the operator picked). The Doorbell, Motion,
 * Battery and Consumables cards each used to read the room's suggestions and
 * draw "N suggested · <room>" beside their own Add — the operator found it on
 * every table of the Customize page. They are source-guarded here because the
 * leak was one import per card: it is the import that must not come back.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const KINDS = path.resolve(HERE, '../kinds')

const read = (file: string): string => readFileSync(path.join(KINDS, file), 'utf8')

describe('room suggestions on the Customize page', () => {
  it('only the Linked devices table reads them', () => {
    const readers = readdirSync(KINDS)
      .filter((f) => f.endsWith('.tsx'))
      .filter((f) => read(f).includes('useRoomSuggestions'))
    expect(readers).toEqual(['LinkedDevicesTable.tsx'])
  })

  it.each([
    'event/EventPulseDialog.tsx',
    'event/EventSpanDialog.tsx',
  ])('%s offers no suggestion entry and passes no room to its picker', (file) => {
    const source = readFileSync(path.resolve(HERE, '..', file), 'utf8')
    expect(source).not.toContain('useRoomSuggestions')
    expect(source).not.toContain('suggestion:')
    expect(source).not.toContain('room={')
  })

  it('the keyed-array item dialog does not read room suggestions', () => {
    const source = readFileSync(path.resolve(HERE, '../keyed/KeyedArrayItemDialog.tsx'), 'utf8')
    expect(source).not.toContain('useRoomSuggestions')
    expect(source).not.toContain('suggestion:')
    expect(source).not.toContain('room={')
  })
})
