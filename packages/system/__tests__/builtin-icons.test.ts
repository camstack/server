/**
 * Every builtin ships its own icon, served by `/api/addon-assets/<id>/<icon>`.
 *
 * A builtin's package dir on the hub is this package (`@camstack/system`), so
 * the route resolves `assets/<id>/icon.svg` here — as long as the manifest
 * declares it, the file exists and `files` ships `assets/` (it used to ship
 * only `dist/`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PKG_DIR = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
  files: string[]
  camstack: { addons: { id: string; icon?: string }[] }
}

describe('@camstack/system builtin icons', () => {
  it('ships assets/ in the tarball', () => {
    expect(pkg.files).toContain('assets')
  })

  it.each(
    pkg.camstack.addons.map((a) => [a.id, a.icon] as const),
  )('%s declares its own icon, and the file is a 24-grid SVG', (id, icon) => {
    expect(icon).toBe(`assets/${id}/icon.svg`)
    const file = join(PKG_DIR, icon ?? '')
    expect(existsSync(file)).toBe(true)
    const svg = readFileSync(file, 'utf8')
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 24 24"/)
    expect(svg.length).toBeLessThan(1500)
  })
})
