/**
 * Locations page is Zones | Locations (SectionedPage) with Identity-style pills.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(path.resolve(HERE, '../../Locations.tsx'), 'utf8')

describe('Locations page shell', () => {
  it('uses AdminSectionedPage with Locations, Camera links and Zones sections', () => {
    expect(SOURCE).toContain('AdminSectionedPage')
    expect(SOURCE).toContain("id: 'locations'")
    expect(SOURCE).toContain("id: 'camera-links'")
    expect(SOURCE).toContain("id: 'zones'")
    expect(SOURCE).toContain('LOCATIONS_UNASSIGNED_ROOM')
    expect(SOURCE).toContain('NewZoneButton')
    expect(SOURCE).toContain('NewLocationButton')
  })

  it('picks the room with the searchable RoomSelect in both room sections, never a tab strip', () => {
    expect(SOURCE).not.toContain('TabsTrigger')
    expect(SOURCE).not.toContain('appearance="pills"')
    // ONE selector element, drawn by both the Locations and the Camera links body.
    expect(SOURCE.match(/<RoomSelect/g)).toHaveLength(1)
    expect(SOURCE.match(/\{roomSelect\}/g)).toHaveLength(2)
    // The choice is the URL's `?room=`, as before.
    expect(SOURCE).toContain("copy.set('room', name)")
  })

  it('mounts exactly ONE New zone control, in the page header actions', () => {
    expect(SOURCE.match(/<NewZoneButton/g)).toHaveLength(1)
    const actions = SOURCE.slice(SOURCE.indexOf('actions={'), SOURCE.indexOf('sections={['))
    expect(actions).toContain('<NewZoneButton')
    expect(SOURCE).not.toContain('createExternally')
  })
})
