/**
 * The passkey app sign-in routes (D858):
 *
 *  - `GET  /auth/app/passkey`        - the standalone page (`app-passkey-page.ts`)
 *  - `POST /auth/app/passkey/begin`  - assertion options (discoverable credentials)
 *  - `POST /auth/app/passkey/finish` - the assertion -> a handoff code at the app
 *
 * The finish verifies the assertion through the `user-passkeys` provider (the
 * same ceremony `auth.passkeyLoginFinish` runs), applies the second-factor rule
 * of any primary login, and mints the ONE-SHOT handoff code - PKCE-bound,
 * state-bound, purpose-aware - for the user the passkey belongs to. It opens no
 * session, reads no cookie and honours no `returnTo`: the destination is the
 * allow-listed app callback, nothing else. Every answer is `{ location }` (or an
 * `{ error }` for a request that is not an app flow at all), so the page just
 * navigates. The app's parameters are never logged.
 */
import {
  APP_FLOW_REFUSAL_MESSAGES,
  appFlowLocation,
  type IUserPasskeysProvider,
  parseAppFlowRequest,
} from '@camstack/types'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AppConfirmations } from './app-confirmations.js'
import { APP_CONFIRM_PARAM, appConfirmCookie } from './app-confirm-routes.js'
import {
  APP_PASSKEY_CSP,
  APP_PASSKEY_REFUSAL_CSP,
  appPasskeyPage,
  appPasskeyRefusalPage,
} from './app-passkey-page.js'
import { appStrings, resolveAppPageLang } from './app-page-strings.js'
import type { AuthNetworkPolicy } from './auth-network-policy.js'
import { clientKeyFromRequest, type RateLimiter } from './auth-rate-limit.js'
import type { SecondFactor } from './second-factors.js'
import { type SessionMinter, SessionUserGoneError } from './session-mint.js'

export const APP_PASSKEY_PATH = '/auth/app/passkey'

export interface AppPasskeyLogger {
  warn(message: string, options?: { meta?: Record<string, unknown> }): void
  error(message: string, options?: { meta?: Record<string, unknown> }): void
}

export interface AppPasskeyDeps {
  /** The `user-passkeys` provider, or `null` when none is up. */
  readonly passkeys: () => IUserPasskeysProvider | null
  /** The second factors `userId` still owes after a passkey primary login. */
  readonly secondFactors: (userId: string) => Promise<readonly SecondFactor[]>
  readonly minter: Pick<SessionMinter, 'findUser'>
  /** Parks the person's confirmation: the code is minted only after "Continue" (D858). */
  readonly confirmations: Pick<AppConfirmations, 'create'>
  readonly network: AuthNetworkPolicy
  readonly limiter: RateLimiter
  readonly logger: AppPasskeyLogger
}

const FinishBodySchema = z.object({
  response: z.record(z.string(), z.unknown()),
  code_challenge: z.string().optional(),
  code_challenge_method: z.string().optional(),
  state: z.string().optional(),
  purpose: z.string().optional(),
  redirect: z.string().optional(),
  lang: z.string().optional(),
})

function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store')
  reply.header('Referrer-Policy', 'no-referrer')
}

export function registerAppPasskeyRoutes(fastify: FastifyInstance, deps: AppPasskeyDeps): void {
  const limited = (bucket: string, request: unknown, reply: FastifyReply): boolean => {
    const client = clientKeyFromRequest(request, deps.network)
    if (client === null) return false
    const verdict = deps.limiter.check(`${bucket}:${client}`)
    if (verdict.allowed) return false
    reply.header('retry-after', String(verdict.retryAfterSeconds))
    void reply.status(429).send({ error: 'Too many attempts' })
    return true
  }

  fastify.get<{ Querystring: Record<string, string | undefined> }>(
    APP_PASSKEY_PATH,
    async (request, reply) => {
      noStore(reply)
      reply.type('text/html; charset=utf-8')
      const parsed = parseAppFlowRequest(request.query)
      const lang = resolveAppPageLang({
        lang: parsed.ok ? parsed.request.lang : request.query['lang'],
        acceptLanguage: request.headers['accept-language'],
      })
      if (!parsed.ok) {
        deps.logger.warn('Passkey app sign-in refused at the page', {
          meta: { reason: parsed.reason },
        })
        reply.header('Content-Security-Policy', APP_PASSKEY_REFUSAL_CSP)
        return reply
          .status(400)
          .send(appPasskeyRefusalPage(appStrings(lang).refused.reasons[parsed.reason], lang))
      }
      reply.header('Content-Security-Policy', APP_PASSKEY_CSP)
      const cancel = appFlowLocation(
        parsed.request.redirect,
        { error: 'cancelled' },
        parsed.request.state,
      )
      return reply.send(appPasskeyPage(cancel, lang))
    },
  )

  fastify.post(`${APP_PASSKEY_PATH}/begin`, async (request, reply) => {
    noStore(reply)
    if (limited('app-passkey-begin', request, reply)) return reply
    const body = z.record(z.string(), z.unknown()).safeParse(request.body)
    const query = body.success
      ? Object.fromEntries(
          Object.entries(body.data).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])),
        )
      : {}
    const parsed = parseAppFlowRequest(query)
    if (!parsed.ok)
      return reply.status(400).send({ error: APP_FLOW_REFUSAL_MESSAGES[parsed.reason] })
    const provider = deps.passkeys()
    if (provider === null) return reply.status(503).send({ error: 'Passkeys are not available.' })
    try {
      return await reply.send(await provider.beginDiscoverableAuthentication({}))
    } catch (error: unknown) {
      deps.logger.error('Passkey app sign-in begin failed', {
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
      return reply.status(500).send({ error: 'Passkeys are not available.' })
    }
  })

  fastify.post(`${APP_PASSKEY_PATH}/finish`, async (request, reply) => {
    noStore(reply)
    if (limited('app-passkey-finish', request, reply)) return reply
    const body = FinishBodySchema.safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'Malformed sign-in request.' })
    const parsed = parseAppFlowRequest({
      code_challenge: body.data.code_challenge,
      code_challenge_method: body.data.code_challenge_method,
      state: body.data.state,
      purpose: body.data.purpose,
      redirect: body.data.redirect,
      lang: body.data.lang,
    })
    if (!parsed.ok)
      return reply.status(400).send({ error: APP_FLOW_REFUSAL_MESSAGES[parsed.reason] })
    const app = parsed.request
    const deny = (error: string) => {
      deps.logger.warn('Passkey app sign-in refused', { meta: { error } })
      return reply.send({ location: appFlowLocation(app.redirect, { error }, app.state) })
    }
    const provider = deps.passkeys()
    if (provider === null) return deny('passkey-unavailable')
    try {
      const result = await provider.finishDiscoverableAuthentication({
        response: body.data.response,
      })
      if (!result.verified || result.userId === null) return deny('passkey-failed')
      const record = await deps.minter.findUser(result.userId)
      // The rule of any primary login: owed second factors are not skippable
      // here, and a browser page cannot ask for them - the app uses another method.
      if ((await deps.secondFactors(record.id)).length > 0) return deny('second-factor-required')
      // The assertion verified; before ANY code exists the person confirms that
      // THIS app is the one to sign in (a custom scheme can be claimed by
      // another app, D858). The page goes to the sibling confirmation page; its
      // cookie binds the token to this browser.
      const parked = deps.confirmations.create({
        userId: record.id,
        username: record.username,
        app,
        authMethod: 'passkey',
      })
      reply.header('Set-Cookie', appConfirmCookie(parked.cookie, request.protocol === 'https'))
      return reply.send({
        confirm: `confirm?${APP_CONFIRM_PARAM}=${encodeURIComponent(parked.token)}`,
      })
    } catch (error: unknown) {
      if (error instanceof SessionUserGoneError) return deny('user-gone')
      deps.logger.error('Passkey app sign-in failed', {
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
      return deny('failed')
    }
  })
}
