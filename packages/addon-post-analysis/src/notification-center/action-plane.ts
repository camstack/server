/**
 * The NC action plane: the PUBLIC route a notification button lands on.
 *
 * Public, like the artifact plane, and for the same reason — the caller is a
 * phone that holds no session. Unlike the artifact plane it does not serve a
 * byte, it MOVES something: the token it verifies is spent on a real actuation.
 * Read `action-token.ts` before touching this; the authorisation model is
 * deliberate and narrower than it looks.
 *
 * Two behaviours worth stating because they are easy to "tidy" into bugs:
 *
 *  - **A bad signature is a flat 404, an unusable TOKEN is a message.** Nothing
 *    that failed the signature check learns anything (a public route that
 *    distinguishes forged from unknown is an oracle). Past that gate the caller
 *    has proven they hold a link this install minted, and telling them "already
 *    used" instead of "not found" is the difference between an operator who
 *    knows the gate opened and one who taps four more times.
 *  - **The token is spent BEFORE the sequence runs.** A sequence that fails
 *    does not hand the token back. Retrying an actuation that may have half-run
 *    ("unlock, wait, open" failing at step three) is precisely the intent the
 *    operator never expressed, and the runner already stops at the first
 *    failure for the same reason.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IScopedLogger } from '@camstack/types'
import {
  type NcActionClaimFailure,
  type NcActionGrant,
  NcActionRefusedError,
  NcActionTokenRegistry,
  verifyActionSignature,
} from './action-token.js'

/** Run what the grant authorises. Throwing means it failed. */
export type NcActionSequenceRunner = (grant: NcActionGrant) => Promise<void>

export interface NcActionPlaneDeps {
  readonly registry: NcActionTokenRegistry
  readonly secret: string
  readonly logger: IScopedLogger
  readonly run: NcActionSequenceRunner
  readonly now?: () => number
}

/**
 * What a spent grant DID, in the operator's own terms.
 *
 * Per `kind`, because the families answer different questions and one
 * generic "Done" would leave a snooze indistinguishable from an open gate on
 * the page a tap lands on. The switch is exhaustive by construction — a new
 * grant family will not compile until it has a sentence here.
 */
function describeGrant(grant: NcActionGrant): string {
  switch (grant.kind) {
    case 'sequence':
      // The button the operator configured on the rule — the grant carries no
      // sequence NAME, and its id is an opaque store key.
      return `${grant.ruleName} — ${grant.actionId}`
    case 'snooze':
      return grant.classes === undefined || grant.classes.length === 0
        ? `Silenced for ${grant.minutes} min`
        : `Silenced for ${grant.minutes} min — ${grant.classes.join(', ')}`
    case 'alarm':
      if (grant.action === 'arm-anyway') return 'Alarm armed, around the open devices'
      if (grant.action === 'bypass-input') return `Input bypassed until disarm — ${grant.ruleName}`
      return grant.action === 'disarm'
        ? 'Alarm disarmed'
        : `Alarm armed${grant.mode !== undefined ? ` (${grant.mode})` : ''}`
    // Describes the GRANT, like every line above it — what this button was
    // for, not what the run achieved. The verdict is a notification, because a
    // background POST's body is a line nobody reads.
    case 'addon-update':
      return `${grant.packages.length} addon update(s) on ${grant.nodeId}`
    case 'server-update':
      return `Server update on ${grant.nodeId}`
  }
}

/** The audit line's `meta`, per family. A snooze that logged a `sequence` it
 *  does not have would be a line nobody can grep. */
function grantMeta(grant: NcActionGrant): Readonly<Record<string, unknown>> {
  const common = { action: grant.actionId, targetId: grant.targetId ?? null }
  switch (grant.kind) {
    case 'sequence':
      return {
        ...common,
        ruleId: grant.ruleId,
        rule: grant.ruleName,
        sequenceId: grant.sequenceId,
      }
    case 'snooze':
      return {
        ...common,
        ruleId: grant.ruleId,
        rule: grant.ruleName,
        userId: grant.userId,
        minutes: grant.minutes,
        classes: grant.classes ?? null,
      }
    case 'alarm':
      if (grant.action === 'bypass-input') {
        return {
          ...common,
          alarm: grant.action,
          ruleId: grant.ruleId,
          rule: grant.ruleName,
          inputDeviceId: grant.inputDeviceId,
          panelDeviceId: grant.panelDeviceId,
        }
      }
      return grant.action === 'arm-anyway'
        ? {
            ...common,
            alarm: grant.action,
            refusalId: grant.refusalId,
            panelDeviceId: grant.panelDeviceId,
          }
        : {
            ...common,
            alarm: grant.action,
            mode: grant.mode ?? null,
            panelDeviceId: grant.panelDeviceId,
          }
    case 'addon-update':
      return { ...common, nodeId: grant.nodeId, packages: grant.packages }
    case 'server-update':
      return { ...common, nodeId: grant.nodeId }
  }
}

/** What the human standing in front of the page is told. */
const FAILURE_COPY: Record<NcActionClaimFailure, string> = {
  unknown: 'This button is no longer available.',
  expired: 'This button has expired. Open CamStack to do it there.',
  'already-used': 'Already done — this button had been used.',
}

function page(title: string, detail: string): string {
  // Self-contained and tiny: it renders inside whatever in-app browser ntfy or
  // a push relay opens, which cannot be assumed to fetch anything else.
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee}main{max-width:24rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#aaa}</style><main><h1>${title}</h1><p>${detail}</p></main>`
}

export class NcActionPlane {
  private readonly now: () => number

  constructor(private readonly deps: NcActionPlaneDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const id = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
    // A BACKGROUND call — Zentik's `BACKGROUND_CALL`, ntfy's `http` action —
    // is a POST that nobody looks at: the phone fires it and keeps the
    // notification where it is. Sending an HTML page back would have the OS
    // parse (and sometimes RENDER, in an in-app browser) a document for a tap
    // that was meant to be invisible. One short line, `text/plain`.
    const background = (req.method ?? 'GET').toUpperCase() === 'POST'

    const signed = verifyActionSignature({
      secret: this.deps.secret,
      id,
      exp: Number(url.searchParams.get('exp')),
      sig: url.searchParams.get('sig') ?? '',
      nowMs: this.now(),
    })
    if (!signed) {
      // Logged: a burst of these on a public route is the only signal that
      // someone is probing, and silence here would read as "never happened".
      this.deps.logger.warn('nc action callback refused — bad or expired signature', {
        meta: { id },
      })
      this.reply(res, background, 404, 'Not found', 'This link is not valid.')
      return
    }

    const claim = this.deps.registry.claim(id)
    if (!claim.ok) {
      this.deps.logger.info('nc action callback not claimable', {
        meta: { id, reason: claim.reason },
      })
      // 200, not an error status: this is a human-readable outcome page, and an
      // in-app browser that renders 4xx as its own error screen would hide it.
      this.reply(res, background, 200, 'Nothing to do', FAILURE_COPY[claim.reason])
      return
    }

    const grant = claim.grant
    try {
      await this.deps.run(grant)
      this.deps.logger.info('nc action ran from a notification button', {
        tags: { deviceId: grant.deviceId },
        meta: { kind: grant.kind, background, ...grantMeta(grant) },
      })
      this.reply(res, background, 200, 'Done', describeGrant(grant))
    } catch (err) {
      if (err instanceof NcActionRefusedError) {
        // Refused for a reason the person CAN act on ("the alarm changed since
        // this notification"): the reason is the whole answer, not "failed".
        this.deps.logger.info('nc action refused after the token was spent', {
          tags: { deviceId: grant.deviceId },
          meta: { kind: grant.kind, ...grantMeta(grant), reason: err.message },
        })
        this.reply(res, background, 200, 'Nothing was done', err.message)
        return
      }
      // The token is already spent. Saying so matters: an operator told only
      // "failed" will tap again and find the button dead, and conclude the
      // FAILURE was the dead button rather than the actuation.
      this.deps.logger.warn('nc action failed after the token was spent', {
        tags: { deviceId: grant.deviceId },
        meta: { kind: grant.kind, ...grantMeta(grant), error: String(err) },
      })
      this.reply(
        res,
        background,
        200,
        'It did not work',
        'The action failed and this button is now spent. Open CamStack.',
      )
    }
  }

  /** One outcome, in the shape the caller can use: a page for a tap, a line
   *  for a background POST. */
  private reply(
    res: ServerResponse,
    background: boolean,
    status: number,
    title: string,
    detail: string,
  ): void {
    if (background) {
      this.sendBody(res, status, 'text/plain; charset=utf-8', `${title}: ${detail}`)
      return
    }
    this.sendBody(res, status, 'text/html; charset=utf-8', page(title, detail))
  }

  private sendBody(res: ServerResponse, status: number, contentType: string, body: string): void {
    res.writeHead(status, {
      'content-type': contentType,
      // A button page must never be cached: a relay or in-app browser replaying
      // it would show "Done" for a tap that never reached us.
      'cache-control': 'no-store',
    })
    res.end(body)
  }
}
