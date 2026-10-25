/**
 * Guard: EVERY route in `main.ts` that serves an SPA shell stamps the shell
 * cache policy — and every ADMIN shell route goes through `sendSpaShell`.
 *
 * The hub serves the admin shell from TWO places, and they drifted once: the
 * admin `/*` fallback set a cache header, while the addon-route catch-all
 * (`GET /addon/:addonId/*` with no matching addon route → `spaIndexHtml`) sent
 * the same HTML with NO cache-control at all. Browsers then heuristically
 * cached an index.html that names hashed assets by build — after a deploy the
 * operator got the previous UI, or a blank page whose assets 404, until a
 * manual force refresh.
 *
 * `sendSpaShell` (`api/static/spa-mount.ts`) now owns that policy, and one
 * more thing besides: under `X-Forwarded-Prefix` it injects the `<base href>`
 * and the `camstack-mount` meta that tell the page where it is mounted. So an
 * admin shell sent any OTHER way is now two silent faults, not one — a stale
 * shell AND a page that composes every hub URL at the root while the Home
 * Assistant relay serves it under `/api/camstack/p/<grant>/`. Neither is
 * visible in review: at the root mount the two spellings behave identically.
 *
 * `/viewer/*` is the Expo viewer app, not this SPA; it owns its own base and
 * only has to keep the cache policy.
 *
 * The route layer is a 1700-line bootstrap with no cheap harness, so this
 * guard reads the source. The policy VALUE is unit-tested in
 * `api/static/__tests__/spa-static.spec.ts` and the injection in
 * `api/static/__tests__/spa-mount.spec.ts`; what can silently regress HERE is
 * a shell-send site added that bypasses both.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN = path.resolve(__dirname, '..', 'main.ts')

/** A shell streamed straight off disk, bypassing `sendSpaShell`. */
const RAW_SHELL_SEND =
  /reply[\s\S]{0,200}?\.send\(fs\.createReadStream\((spaIndexHtml|indexPath)\)\)/g

function readMain(): string {
  return fs.readFileSync(MAIN, 'utf-8')
}

/** The body of a `fastify.get('<route>', …)` handler, to the next `fastify.` */
function routeBlock(source: string, route: string): string {
  const start = source.indexOf(`fastify.get('${route}'`)
  expect(start, `route ${route} is gone from main.ts`).toBeGreaterThan(-1)
  const next = source.indexOf('\n  fastify.', start + 1)
  return source.slice(start, next === -1 ? source.length : next)
}

describe('SPA shell cache headers', () => {
  it('every raw shell send still stamps the shell cache policy', () => {
    const source = readMain()
    const sites = [...source.matchAll(RAW_SHELL_SEND)]
    for (const site of sites) {
      const start = Math.max(0, (site.index ?? 0) - 400)
      const window = source.slice(start, (site.index ?? 0) + site[0].length)
      expect(window, `raw shell send at ${site.index} has no cache policy`).toContain(
        'spaShellCacheControl()',
      )
    }
  })

  it('the admin shell routes go through sendSpaShell — policy AND mount injection', () => {
    const source = readMain()
    // The admin `/*` fallback.
    const adminFallback = routeBlock(source, '/*')
    expect(adminFallback).toContain('sendSpaShell(reply, indexPath, request.headers)')
    expect(adminFallback).not.toMatch(RAW_SHELL_SEND)

    // The addon-route catch-all — the site that once shipped bare.
    const addonFallback = source.indexOf("if (method === 'GET' && spaIndexHtml)")
    expect(addonFallback).toBeGreaterThan(-1)
    const block = source.slice(addonFallback, addonFallback + 800)
    expect(block).toContain('sendSpaShell(reply, spaIndexHtml, request.headers)')
  })

  it('the viewer shell is a different app: its own route, its own cache header', () => {
    const viewer = routeBlock(readMain(), '/viewer/*')
    expect(viewer).toContain('spaShellCacheControl()')
  })

  it('the shell asked for by name is the shell, never the asset branch', () => {
    // `/index.html` under the relay must get `<base>` too; routing it to the
    // static branch would serve the uninjected file with an immutable policy.
    expect(routeBlock(readMain(), '/*')).toContain("pathOnly !== '/index.html'")
  })

  it('hashed assets keep their own policy — the shell header is not applied wholesale', () => {
    const source = readMain()
    expect(source.match(/spaAssetCacheControl\(rel\)/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
