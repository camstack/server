/**
 * `GET /auth/app/refused?reason=<code>` - the page that says why a native app
 * sign-in could not start (D858).
 *
 * The OIDC start lives in an addon, which cannot reach the hub's theme; it
 * redirects here with a reason CODE (and the app's optional `lang`) and the hub renders the
 * sentence, in the language of `lang`/`Accept-Language`, in the same shell as every other app page. The query is never echoed: an unknown or
 * absent code gets a generic sentence, a known one its fixed words.
 */
import { APP_REFUSED_PATH, isAppStartRefusal } from '@camstack/types'
import type { FastifyInstance } from 'fastify'
import { appHint, appPageCsp, appParagraph, renderAppPage } from './app-page-shell.js'
import { type AppPageLang, appStrings, resolveAppPageLang } from './app-page-strings.js'

/** The refusal page for `reason` (a known code, or anything: unknown renders the generic sentence). */
export function appRefusedPage(reason: unknown, lang: AppPageLang): string {
  const t = appStrings(lang).refused
  const message = isAppStartRefusal(reason) ? t.reasons[reason] : t.generic
  return renderAppPage({
    lang,
    title: t.title,
    heading: t.title,
    body: appParagraph(message) + appHint(t.hint),
  })
}

/** CSP of the refusal page: the shell's style only, nothing runs. */
export const APP_REFUSED_CSP = appPageCsp()

export function registerAppRefusedRoute(fastify: FastifyInstance): void {
  fastify.get<{ Querystring: Record<string, string | undefined> }>(
    APP_REFUSED_PATH,
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      reply.header('Referrer-Policy', 'no-referrer')
      reply.header('Content-Security-Policy', APP_REFUSED_CSP)
      reply.type('text/html; charset=utf-8')
      const lang = resolveAppPageLang({
        lang: request.query['lang'],
        acceptLanguage: request.headers['accept-language'],
      })
      return reply.status(400).send(appRefusedPage(request.query['reason'], lang))
    },
  )
}
