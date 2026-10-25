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
