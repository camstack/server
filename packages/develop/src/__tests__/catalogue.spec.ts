import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findAddonPackage, listAddonPackages, whoProvides } from '../catalogue/addons.js'
import { getCapability, listCapabilities } from '../catalogue/capabilities.js'
import { findExample } from '../examples/find.js'
import { findWorkspaceRoot } from '../workspace.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

describe('catalogue against this workspace', () => {
  const root = findWorkspaceRoot(HERE)
  if (!root) {
    throw new Error('expected to run inside camstack-server workspace')
  }

  it('lists addon packages including smtp-nodemailer', () => {
    const pkgs = listAddonPackages(root)
    expect(pkgs.length).toBeGreaterThan(10)
    const smtp = pkgs.find((p) => p.packageName === '@camstack/addon-smtp-nodemailer')
    expect(smtp).toBeDefined()
    expect(smtp?.addons.some((a) => a.id === 'smtp-nodemailer')).toBe(true)
  })

  it('resolves an addon by short id', () => {
    const pkg = findAddonPackage(root, 'smtp-nodemailer')
    expect(pkg?.packageName).toBe('@camstack/addon-smtp-nodemailer')
  })

  it('lists capabilities from *.cap.ts sources', () => {
    const caps = listCapabilities(root)
    expect(caps.length).toBeGreaterThan(20)
    const smtp = getCapability(root, 'smtp-provider')
    expect(smtp?.relativeFile).toContain('smtp-provider.cap.ts')
  })

  it('whoProvides finds smtp-provider implementers', () => {
    const hits = whoProvides(root, 'smtp-provider')
    expect(hits.some((h) => h.addon.id === 'smtp-nodemailer')).toBe(true)
  })

  it('findExample ranks provider queries toward provider packages', () => {
    const hits = findExample(root, 'device provider camera')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.example.kind).toBe('provider')
  })
})

describe('integration examples', () => {
  const root = findWorkspaceRoot(HERE)

  it.each([
    ['device-integration', 'integration-device-enpal', 'integration-device-example'],
    ['service-integration', 'integration-service-cloudflare', 'integration-service-example'],
    ['exporter', 'exporter-ha-export', 'exporter-example'],
  ])('%s points at the in-repo implementation and the public example', (kind, inRepo, pub) => {
    const hits = findExample(root, kind)
    const ids = hits.map((h) => h.example.id)
    expect(ids).toContain(inRepo)
    expect(ids).toContain(pub)
    const publicHit = hits.find((h) => h.example.id === pub)
    expect(publicHit?.example.repository).toBe('camstack/addon-examples')
    // A public example is not penalised for being absent from this checkout.
    expect(publicHit?.rationale).not.toContain('missing')
    expect(
      fs.existsSync(path.join(root, hits.find((h) => h.example.id === inRepo)!.example.packageDir)),
    ).toBe(true)
  })
})
