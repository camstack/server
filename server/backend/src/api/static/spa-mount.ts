/**
 * spa-mount — serving the admin-UI shell under a reverse-proxy path prefix.
 *
 * The Home Assistant component frames the admin UI through a same-origin
 * relay, `https://<ha>/api/camstack/p/<grant>/…` → `https://<hub>:4443/…`, so
 * the browser never has to trust the hub's local certificate. The relay
 * forwards the path WITHOUT the prefix (the hub sees `/`, `/settings`,
 * `/assets/x.js`, `/trpc`) and says where it mounted us with
 * `X-Forwarded-Prefix: /api/camstack/p/<grant>` on every request.
 *
 * The shell is the one response that has to differ: it tells the page where
 * it lives, and every URL the page composes derives from that
 * (`@camstack/ui-library` `lib/hub-mount.ts`). Assets are already relative
 * (`vite base: './'`), so they need nothing from us.
 *
 * Without the header nothing changes — the shell is served exactly as before.
 */
import * as fs from 'node:fs/promises'
import type { IncomingHttpHeaders } from 'node:http'
import type { FastifyReply } from 'fastify'
import { spaShellCacheControl } from './spa-static'

/** Node lower-cases incoming header names. */
export const FORWARDED_PREFIX_HEADER = 'x-forwarded-prefix'

/** The canonical spelling, for `Vary`. */
const FORWARDED_PREFIX_VARY = 'X-Forwarded-Prefix'

const MOUNT_META_NAME = 'camstack-mount'

/**
 * A prefix is one or more clean path segments. No scheme, no `//`, no `..`,
 * no query, no whitespace, no markup — it is going into an HTML attribute.
 */
const PREFIX_RE = /^\/[A-Za-z0-9_\-.]+(?:\/[A-Za-z0-9_\-.]+)*$/
const MAX_PREFIX_LENGTH = 512

type HeaderValue = string | readonly string[] | undefined

/**
 * The mount prefix the relay named, without a trailing slash, or `null` when
 * the header is absent, names the root, or is anything we would not put in
 * an attribute. Invalid is treated as absent — a relay that gets this wrong
 * gets the root shell, never a 4xx and never a partial injection.
 */
export function parseForwardedPrefix(value: HeaderValue): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > MAX_PREFIX_LENGTH) return null
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value
  if (trimmed === '') return null
  if (!PREFIX_RE.test(trimmed)) return null
  if (trimmed.split('/').some((segment) => segment === '..' || segment === '.')) return null
  return trimmed
}

/**
 * The shell with `<base href>` and the mount meta as the FIRST children of
 * `<head>` — `<base>` must precede every URL-bearing element to apply to it.
 * A shell with no `<head>` is returned untouched: guessing where to put a
 * `<base>` is worse than serving the root shell.
 *
 * The `<base>` is written for EVERY request, mount or not. The shell's assets
 * are relative (`vite base: './'`) and the SPA serves the same shell at every
 * depth, so without a base `/devices` asks for `/devices/assets/…` and every
 * chunk 404s — the admin UI was broken on every deep route the moment the
 * relative build shipped, and only the root worked (operator, 2026-09-07).
 * A root mount is therefore `<base href="/">`, not "no base at all".
 */
export function injectSpaMount(html: string, prefix: string): string {
  const match = /<head(?:\s[^>]*)?>/i.exec(html)
  if (match === null) return html
  const mount = `${prefix}/`
  const injected = `<base href="${mount}"><meta name="${MOUNT_META_NAME}" content="${mount}">`
  const at = match.index + match[0].length
  return `${html.slice(0, at)}${injected}${html.slice(at)}`
}

/**
 * Send the SPA shell for a page navigation. Always `no-store` and always
 * `Vary: X-Forwarded-Prefix` — a cache that ignores `no-store` must still
 * never hand a root shell to a relayed request or vice versa.
 */
export async function sendSpaShell(
  reply: FastifyReply,
  indexPath: string,
  headers: IncomingHttpHeaders,
): Promise<FastifyReply> {
  reply.header('cache-control', spaShellCacheControl())
  reply.header('vary', FORWARDED_PREFIX_VARY)
  let html: string
  try {
    html = await fs.readFile(indexPath, 'utf8')
  } catch {
    // A redeploy replaced the dist under us; the next request finds the new one.
    return reply.status(503).send({ error: 'Admin UI shell unavailable' })
  }
  // `''` is the root mount: `injectSpaMount` writes `<base href="/">`, which a
  // relative-asset shell needs at every depth. Never "no base".
  const prefix = parseForwardedPrefix(headers[FORWARDED_PREFIX_HEADER]) ?? ''
  return reply.type('text/html').send(injectSpaMount(html, prefix))
}
