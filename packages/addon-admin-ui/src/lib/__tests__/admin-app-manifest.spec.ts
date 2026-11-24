import { describe, expect, it } from 'vitest'
import { AppDeclarationSchema } from '@camstack/types'
import { buildAdminApp } from '../../server/admin-app'
import { buildAdminNavManifest } from '../nav-data'
import { buildNavSections, navIconFor, type NavTranslate } from '../nav-items'

// A `t` that answers the way the real one does with the English bundle loaded.
const t: NavTranslate = (key: string, defaultValue?: string) => defaultValue ?? key

function iconName(component: ReturnType<typeof navIconFor>): string {
  const names = buildAdminNavManifest()
    .flatMap((s) => s.items)
    .map((i) => i.icon)
  const found = names.find((n) => navIconFor(n) === component)
  if (found === undefined) throw new Error('icon not in the manifest')
  return found
}

describe('Admin app declaration', () => {
  it('is adminOnly, valid against the cap schema, served at the hub root', () => {
    const app = buildAdminApp()
    expect(AppDeclarationSchema.safeParse(app).success).toBe(true)
    expect(app.id).toBe('admin')
    expect(app.adminOnly).toBe(true)
    expect(app.entry).toEqual({ kind: 'web', path: '/', auth: 'handoff' })
  })
})

describe('Admin manifest parity with buildNavSections', () => {
  it('equals the sidebar an embedded admin sees (every section, item, label, icon, path, flag)', () => {
    const sidebar = buildNavSections({ t, isAdmin: true, embeddedByViewer: true })
    const projected = sidebar.map((section) => ({
      id: section.key,
      label: section.label,
      items: section.items.map((item) => ({
        id: item.path,
        label: item.label,
        icon: iconName(item.icon),
        path: item.path,
        adminOnly: item.adminOnly === true,
        keywords: item.keywords ?? null,
        requiresCapability: item.requiresCapability ?? null,
      })),
    }))
    const manifest = buildAdminNavManifest().map((section) => ({
      id: section.id,
      label: section.label === null ? null : section.label.fallback,
      items: section.items.map((item) => ({
        id: item.id,
        label: item.label.fallback,
        icon: item.icon,
        path: item.path,
        adminOnly: item.adminOnly === true,
        keywords: item.keywords ?? null,
        requiresCapability: item.requiresCapability ?? null,
      })),
    }))
    expect(manifest).toEqual(projected)
  })

  it('keeps for a non-admin exactly the items the sidebar shows them', () => {
    const sidebar = buildNavSections({ t, isAdmin: false, embeddedByViewer: true })
    const visible = buildAdminNavManifest().map((section) =>
      section.items.filter((item) => item.adminOnly !== true).map((item) => item.path),
    )
    expect(visible).toEqual(sidebar.map((section) => section.items.map((item) => item.path)))
  })
})
