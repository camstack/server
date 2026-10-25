/**
 * D4 guard — addon package.json manifests must declare only WHICH caps
 * an addon provides. Behavioural metadata (kind, defaultActive, mode) belongs
 * exclusively on the .cap.ts definition.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findManifestMetadataDrift } from '../capability-metadata-drift.ts'

describe('findManifestMetadataDrift', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-meta-drift-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writePkg(name: string, content: unknown): string {
    const file = path.join(tmpDir, name)
    fs.writeFileSync(file, JSON.stringify(content))
    return file
  }

  it('returns no drift for a clean manifest', () => {
    const file = writePkg('clean.json', {
      camstack: {
        addons: [{ id: 'a', capabilities: [{ name: 'detection-pipeline' }, { name: 'reboot' }] }],
      },
    })
    expect(findManifestMetadataDrift([file])).toEqual([])
  })

  it('flags a manifest entry that still carries kind', () => {
    const file = writePkg('dirty.json', {
      camstack: {
        addons: [{ id: 'a', capabilities: [{ name: 'detection-pipeline', kind: 'wrapper' }] }],
      },
    })
    const drift = findManifestMetadataDrift([file])
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({
      addonId: 'a',
      capName: 'detection-pipeline',
      offendingKeys: ['kind'],
    })
  })

  it('flags both kind and defaultActive on the same entry', () => {
    const file = writePkg('dirty2.json', {
      camstack: {
        addons: [{ id: 'a', capabilities: [{ name: 'x', kind: 'wrapper', defaultActive: true }] }],
      },
    })
    expect(findManifestMetadataDrift([file])[0]?.offendingKeys).toEqual(['kind', 'defaultActive'])
  })

  it('ignores files without a camstack.addons block', () => {
    const file = writePkg('plain.json', { name: 'not-an-addon' })
    expect(findManifestMetadataDrift([file])).toEqual([])
  })

  it('flags drift in the second addon of a multi-addon manifest', () => {
    const file = writePkg('multi.json', {
      camstack: {
        addons: [
          { id: 'a', capabilities: [{ name: 'clean-cap' }] },
          { id: 'b', capabilities: [{ name: 'dirty-cap', kind: 'native' }] },
        ],
      },
    })
    const drift = findManifestMetadataDrift([file])
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ addonId: 'b', capName: 'dirty-cap' })
  })

  it('ignores a capabilities array containing a non-object entry', () => {
    const file = writePkg('weird.json', {
      camstack: { addons: [{ id: 'a', capabilities: [null, 'just-a-string', { name: 'ok' }] }] },
    })
    expect(findManifestMetadataDrift([file])).toEqual([])
  })

  it('flags a manifest entry that still carries mode', () => {
    const file = writePkg('mode.json', {
      camstack: { addons: [{ id: 'a', capabilities: [{ name: 'storage', mode: 'singleton' }] }] },
    })
    const drift = findManifestMetadataDrift([file])
    expect(drift).toHaveLength(1)
    expect(drift[0]).toMatchObject({ addonId: 'a', capName: 'storage', offendingKeys: ['mode'] })
  })
})
