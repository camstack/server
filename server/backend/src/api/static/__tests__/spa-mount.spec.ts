import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FORWARDED_PREFIX_HEADER,
  injectSpaMount,
  parseForwardedPrefix,
  sendSpaShell,
} from '../spa-mount'

/**
 * A reverse proxy that mounts the admin UI under a path prefix (the Home
 * Assistant relay: `https://<ha>/api/camstack/p/<grant>/…` → hub `/…`) says
 * so with `X-Forwarded-Prefix`. The shell is the ONE response that has to
 * differ: it tells the page where it lives. Everything else is the page's
 * job (`@camstack/ui-library` `hub-mount.ts`).
 */

describe('parseForwardedPrefix', () => {
  it('accepts a clean absolute path without a trailing slash', () => {
    expect(parseForwardedPrefix('/api/camstack/p/abc-123')).toBe('/api/camstack/p/abc-123')
    expect(parseForwardedPrefix('/x/g1/')).toBe('/x/g1')
    expect(parseForwardedPrefix('/a_b.c-d')).toBe('/a_b.c-d')
  })

  it('is null when the header is absent, empty, or names the root', () => {
    expect(parseForwardedPrefix(undefined)).toBeNull()
    expect(parseForwardedPrefix('')).toBeNull()
    expect(parseForwardedPrefix('/')).toBeNull()
  })

  it('rejects anything that could escape the mount or smuggle markup', () => {
    expect(parseForwardedPrefix('api/x')).toBeNull()
    expect(parseForwardedPrefix('/x/../y')).toBeNull()
    expect(parseForwardedPrefix('/x//y')).toBeNull()
    expect(parseForwardedPrefix('//evil.example/x')).toBeNull()
    expect(parseForwardedPrefix('/x/"><script>')).toBeNull()
    expect(parseForwardedPrefix('/x/g1?x=1')).toBeNull()
    expect(parseForwardedPrefix('/x/g1 ')).toBeNull()
    expect(parseForwardedPrefix('/x/é')).toBeNull()
    expect(parseForwardedPrefix(['/x', '/y'])).toBeNull()
    expect(parseForwardedPrefix(`/${'a'.repeat(600)}`)).toBeNull()
  })
})

describe('injectSpaMount', () => {
  it('writes <base href="/"> for the ROOT mount — a relative shell needs one at every depth', () => {
    // `vite base: './'` plus the SPA serving the same shell at every depth: on
    // `/devices` a missing base makes every chunk resolve to
    // `/devices/assets/…` and 404. The admin UI was broken on every deep route
    // (operator, 2026-09-07); only the root worked.
    const out = injectSpaMount('<html><head><title>x</title></head></html>', '')
    expect(out).toContain('<base href="/">')
    expect(out).toContain('content="/"')
    expect(out.indexOf('<base')).toBeLessThan(out.indexOf('<title>'))
  })

  const shell =
    '<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>CamStack Admin</title>\n  </head>\n  <body></body>\n</html>\n'

  it('puts <base> and the mount meta first in <head>, with the trailing slash', () => {
    const out = injectSpaMount(shell, '/x/g1')
    const head = out.indexOf('<head>')
    const base = out.indexOf('<base href="/x/g1/">')
    const meta = out.indexOf('<meta name="camstack-mount" content="/x/g1/">')
    const charset = out.indexOf('<meta charset')
    expect(base).toBeGreaterThan(head)
    expect(meta).toBeGreaterThan(base)
    expect(charset).toBeGreaterThan(meta)
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
  })

  it('leaves a shell with no <head> untouched rather than guessing', () => {
    expect(injectSpaMount('<html><body></body></html>', '/x/g1')).toBe('<html><body></body></html>')
  })

  it('is case-insensitive on the tag', () => {
    expect(injectSpaMount('<HTML><HEAD></HEAD></HTML>', '/x')).toContain('<base href="/x/">')
  })
})

describe('sendSpaShell (fastify inject)', () => {
  let dir: string
  let indexPath: string
  const app = Fastify()

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spa-mount-'))
    indexPath = path.join(dir, 'index.html')
    await fs.writeFile(
      indexPath,
      '<!DOCTYPE html><html><head><title>t</title></head><body></body></html>',
    )
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  app.get('/*', async (request, reply) => sendSpaShell(reply, indexPath, request.headers))

  it('serves the ROOT mount without the header, and still varies on it', async () => {
    // This asserted `not.toContain('<base')` until 2026-09-07, and that was
    // wrong: with relative assets the shell needs a base at every depth, and
    // `/settings` — a deep route, as here — asked for `/settings/assets/…` and
    // 404'd on every chunk. The root mount is `<base href="/">`, explicitly.
    const res = await app.inject({ method: 'GET', url: '/settings' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers.vary).toBe('X-Forwarded-Prefix')
    expect(res.body).toContain('<base href="/">')
    expect(res.body).toContain('content="/"')
  })

  it('injects the mount when the relay names a valid prefix', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { [FORWARDED_PREFIX_HEADER]: '/api/camstack/p/g1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers.vary).toBe('X-Forwarded-Prefix')
    expect(res.body).toContain('<base href="/api/camstack/p/g1/">')
    expect(res.body).toContain('<meta name="camstack-mount" content="/api/camstack/p/g1/">')
  })

  it('ignores an invalid prefix — the shell is served as if the header were absent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { [FORWARDED_PREFIX_HEADER]: '/x/../"><script>' },
    })
    expect(res.statusCode).toBe(200)
    // Treated as absent — which is the ROOT mount, not "no base": the shell
    // still needs one. What must never appear is the smuggled markup.
    expect(res.body).toContain('<base href="/">')
    expect(res.body).not.toContain('script>')
  })

  /**
   * The Home Assistant component (0.5.12, already released) probes the hub
   * before it will frame the panel: it asks for the index with
   * `X-Forwarded-Prefix: /camstack-mount-probe` and searches the FIRST 16 KB
   * of the body for the literal `name="camstack-mount"`. It has no session —
   * the shell is public and must stay public. This is the released client's
   * contract, so it is asserted the way that client reads it, not the way we
   * happen to write it.
   */
  it('satisfies the released HA 0.5.12 probe: marker inside the first 16 KB, no session', async () => {
    const realShell = await fs.readFile(
      path.join(__dirname, '../../../../../../packages/addon-admin-ui/index.html'),
      'utf8',
    )
    await fs.writeFile(indexPath, realShell)
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { [FORWARDED_PREFIX_HEADER]: '/camstack-mount-probe' },
    })
    expect(res.statusCode).toBe(200)
    const first16k = Buffer.from(res.rawPayload)
      .subarray(0, 16 * 1024)
      .toString('utf8')
    expect(first16k).toContain('name="camstack-mount"')
    expect(first16k).toContain('<base href="/camstack-mount-probe/">')
  })

  it('answers 503 when the shell file is gone (a redeploy race), never a 500', async () => {
    await fs.rm(indexPath)
    const res = await app.inject({ method: 'GET', url: '/settings' })
    expect(res.statusCode).toBe(503)
  })
})
