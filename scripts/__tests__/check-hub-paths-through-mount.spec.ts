import { describe, expect, it } from 'vitest'
import { findHubPathViolations, type HubPathSourceFile } from '../check-hub-paths-through-mount.js'

const file = (path: string, source: string): HubPathSourceFile => ({ path, source })
const ADMIN = 'packages/addon-admin-ui/src/components/X.tsx'

describe('findHubPathViolations', () => {
  it('refuses a bare hub path literal handed to fetch', () => {
    const v = findHubPathViolations([file(ADMIN, `await fetch('/api/auth/session')`)])
    expect(v).toHaveLength(1)
    expect(v[0]?.rule).toBe('bare-hub-path')
    expect(v[0]?.line).toBe(1)
  })

  it('refuses a template literal and a double-quoted JSX attribute alike', () => {
    const v = findHubPathViolations([
      file(ADMIN, 'const u = `/api/addon-assets/${id}/icon.svg`\n<img src="/addon/x/y" />'),
    ])
    expect(v.map((x) => x.line)).toEqual([1, 2])
  })

  it('lets the literal through when it is the direct argument of hubPath / hubUrl / hubWsUrl', () => {
    const v = findHubPathViolations([
      file(
        ADMIN,
        [
          `fetch(hubPath('/api/auth/session'))`,
          'const base = hubUrl(`/addon/${id}/io`)',
          `new WebSocket(hubWsUrl('/trpc'))`,
          `export const EVENT_MEDIA_BASE = hubPath('/addon/pipeline-analytics/event-media')`,
        ].join('\n'),
      ),
    ])
    expect(v).toEqual([])
  })

  it('accepts the formatter’s wrapped form — the literal first inside an opened resolver', () => {
    const v = findHubPathViolations([file(ADMIN, `return hubPath(\n  \`/api/x/\${id}\`,\n)`)])
    expect(v).toEqual([])
  })

  it('does not accept a literal that merely follows an unrelated open call', () => {
    const v = findHubPathViolations([file(ADMIN, `fetch(\n  '/api/x',\n)`)])
    expect(v).toHaveLength(1)
  })

  it('does not accept a second argument as the resolver’s', () => {
    const v = findHubPathViolations([file(ADMIN, `hubPath(\n  base,\n  '/api/x',\n)`)])
    expect(v).toHaveLength(1)
  })

  it('refuses a shell-root static asset — the logo that escaped the relay', () => {
    const v = findHubPathViolations([
      file(ADMIN, `<img src="/brand/logo-horizontal-dark.svg" />`),
      file(ADMIN, `<link rel="icon" href="/icons/apple-touch-icon.png" />`),
      file(ADMIN, `const f = '/favicon.svg'`),
    ])
    expect(v.map((x) => x.rule)).toEqual(['bare-hub-path', 'bare-hub-path', 'bare-hub-path'])
  })

  it('lets a wrapped shell-root static asset through', () => {
    const v = findHubPathViolations([
      file(ADMIN, `<img src={hubPath('/brand/logo-horizontal-dark.svg')} />`),
    ])
    expect(v).toEqual([])
  })

  it('refuses the page origin as a hub base', () => {
    const v = findHubPathViolations([
      file(ADMIN, `const serverUrl = window.location.origin`),
      file('packages/ui-library/src/composites/Y.tsx', `probe(location.origin)`),
    ])
    expect(v.map((x) => x.rule)).toEqual(['page-origin', 'page-origin'])
  })

  it('honours an explicit `hub-path-ok:` marker on the same line, with a reason', () => {
    const v = findHubPathViolations([
      file(ADMIN, `<Route path="/addon/:pagePath" /> // hub-path-ok: router pattern, not a URL`),
    ])
    expect(v).toEqual([])
  })

  it('refuses a bare marker with no reason', () => {
    const v = findHubPathViolations([file(ADMIN, `fetch('/api/x') // hub-path-ok:`)])
    expect(v).toHaveLength(1)
  })

  it('ignores comments, tests, and the resolver module itself', () => {
    const v = findHubPathViolations([
      file(ADMIN, `// served by \`/api/addon-assets/<id>\`\n/* '/addon/x' */`),
      file('packages/addon-admin-ui/src/lib/__tests__/x.spec.ts', `fetch('/api/x')`),
      file('packages/ui-library/src/lib/hub-mount.ts', `window.location.origin + '/api/x'`),
    ])
    expect(v).toEqual([])
  })

  it('does not look outside the two web surfaces', () => {
    const v = findHubPathViolations([file('server/backend/src/main.ts', `fetch('/api/x')`)])
    expect(v).toEqual([])
  })
})
