/**
 * The hub's public HTTPS origin — detected, never invented.
 *
 * `publicHubUrl` is the single operator-facing value in this addon, and the
 * three URLs pasted into the Google Home Developer Console (fulfillment,
 * authorization, token) are all rendered from it. Nothing ROUTES on it: Google
 * calls the fulfillment URL it was configured with. A wrong value therefore
 * fails at paste time, in the console, hours before anything here notices —
 * which is exactly why the field has to say where its content came from.
 *
 * ## Where the URL comes from
 *
 * The `network-access` capability, same source `addon-export-alexa` uses. It is
 * a codegen'd collection cap with `scope: 'system'`, so it is reachable
 * cross-process through `ctx.api` — unlike the `addons` core router, which a
 * forked addon calling `ctx.api.addons.*` would wait on forever.
 *
 * **Not** the hub's own address from `local-network` (`getAddresses().roles`). That
 * answers a different question — which address an agent or a browser on the
 * LAN reaches — and it is routinely a LAN address; the backend's
 * `publicHubUrl()` fallback is localhost in dev. Google calls from its own
 * cloud, so a LAN answer here is worse than no answer — it produces three
 * console URLs that look complete and can never be reached.
 *
 * ## Why this is a second copy of Alexa's mechanism
 *
 * Alexa's lives in `packages/addon-export-alexa/src/export-alexa.addon.ts` as
 * private methods, and addons never import each other. The only shared home
 * would be `@camstack/types` or `@camstack/system` — both stay host-resolved in
 * an addon bundle (`tools/build/vite-lib.preset.ts`), so putting it there would
 * put this addon on the framework publish train and destroy the one property
 * that makes it attractive: `camstack deploy packages/addon-export-google` and
 * nothing else. The SOURCE and the POLICY are Alexa's; two behaviours diverge
 * on purpose and both are named below.
 *
 * ## Two deliberate divergences from Alexa
 *
 * 1. **Refresh never clobbers.** Alexa's `redetectPublicHubUrl` replaces a
 *    manual override whenever it is not among the detected endpoints — sound
 *    there, because the URL is baked into every Alexa-bound JWT as a routing
 *    claim and a stale one breaks routing. Here the value is what the operator
 *    already pasted into Google's console; silently rewriting it would leave
 *    the console and the hub disagreeing with no visible cause. Detection fills
 *    an EMPTY field and does nothing else.
 * 2. **A non-routable origin is dropped.** Alexa forwards whatever the cap
 *    reports. See {@link isPubliclyRoutableOrigin}.
 */
import { errMsg, type IScopedLogger } from '@camstack/types'

import type { ExportSetup, GoogleExportSettings } from './types.js'

/**
 * The shape this module needs out of a `network-access` endpoint. Narrower than
 * `NetworkEndpointEntry` on purpose: the addon maps the cap's answers onto it
 * field by field, so a test can supply one without a cast and without
 * inventing a `hostname` / `port` nothing here reads.
 */
export interface PublicEndpointCandidate {
  readonly url: string
  readonly protocol: 'http' | 'https'
}

/** The aggregate `network-access` status, narrowed to what is read here. */
export interface PublicEndpointStatus {
  readonly connected: boolean
  readonly endpoint: PublicEndpointCandidate | null
}

/**
 * Reader over the `network-access` cap. Both methods are expected to RESOLVE
 * with an empty answer rather than reject; a rejection is tolerated and logged.
 */
export interface NetworkAccessReader {
  /** Aggregate `networkAccess.listEndpoints` — every active ingress entry. */
  readonly listEndpoints: () => Promise<readonly PublicEndpointCandidate[]>
  /** Aggregate `networkAccess.getStatus`. `null` when it could not be read. */
  readonly getStatus: () => Promise<PublicEndpointStatus | null>
}

export interface DetectPublicHubOriginsDeps {
  readonly network: NetworkAccessReader
  readonly logger: IScopedLogger
}

/** Whether `publicHubUrl` was typed by a human or filled by detection. */
export type PublicHubUrlSource = 'unset' | 'derived' | 'operator-set'

/** The two persisted strings this module reasons about. */
export interface PublicHubUrlState {
  readonly publicHubUrl: string
  readonly detectedPublicHubUrl: string
}

/** The settings write detection is allowed to make. */
export type PublicHubUrlPatch = Partial<
  Pick<GoogleExportSettings, 'publicHubUrl' | 'detectedPublicHubUrl'>
>

export interface PublicHubUrlResolution {
  /**
   * What to persist. Carries `publicHubUrl` ONLY when the field was empty and
   * detection produced something — a value the operator set is never in here.
   */
  readonly patch: PublicHubUrlPatch
  /** The URL now in force: the operator's when set, the detected default otherwise. */
  readonly publicHubUrl: string
  /** First publicly routable HTTPS origin `network-access` reports. */
  readonly detectedPublicHubUrl: string
  /** True when this resolution FILLED an empty field. */
  readonly defaulted: boolean
}

export interface PublicHubUrlNotice {
  readonly content: string
  readonly variant: 'info' | 'warning'
}

export interface ConsoleSetupInput extends PublicHubUrlState {
  readonly addonId: string
  readonly linkedAccounts: number
}

export interface RefreshPublicHubUrlDeps {
  readonly current: () => PublicHubUrlState
  readonly detect: () => Promise<readonly string[]>
  readonly persist: (patch: PublicHubUrlPatch) => Promise<void>
  readonly logger: IScopedLogger
}

/** Trailing slashes off, surrounding space off. Nothing else is rewritten. */
export const normalisePublicHubUrl = (raw: string): string => raw.trim().replace(/\/+$/, '')

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']

/**
 * Whether Google's cloud could plausibly reach this origin.
 *
 * The `network-access` providers this hub ships (Cloudflare Tunnel, Tailscale
 * Funnel) publish public FQDNs, but the cap does not promise it: a provider is
 * free to report an HTTPS ingress on a private address. Defaulting the field to
 * one of those would hand the operator three console URLs that look finished
 * and can never answer — strictly worse than an empty field, because an empty
 * field is visibly unfinished.
 *
 * Conservative on purpose: only loopback, RFC1918, link-local, `.local` and
 * dotless hostnames are refused. A public tunnel hostname always has a dot.
 */
export const isPubliclyRoutableOrigin = (origin: string): boolean => {
  let host: string
  try {
    host = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host.length === 0) return false
  if (LOOPBACK_HOSTS.includes(host)) return false
  if (host.startsWith('127.') || host.startsWith('169.254.')) return false
  if (host.startsWith('10.') || host.startsWith('192.168.')) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return false
  // No dot ⇒ a bare LAN name (`hub`, `unraid`); nothing outside resolves it.
  if (!host.includes('.')) return false
  return true
}

/**
 * Every publicly routable HTTPS origin the `network-access` cap reports, in the
 * cap's own order, deduped. Empty when there is none — the caller leaves the
 * field alone rather than inventing a value.
 */
export const detectPublicHubOrigins = async (
  deps: DetectPublicHubOriginsDeps,
): Promise<readonly string[]> => {
  const fromList = await originsFromListEndpoints(deps)
  if (fromList.length > 0) return fromList

  // `listEndpoints` is optional on a provider — the cap doc says a
  // single-endpoint provider may omit it — so a silent empty list is normal,
  // not a fault. Ask the aggregate status before giving up.
  const fromStatus = await originFromGetStatus(deps)
  if (fromStatus.length > 0) return [fromStatus]

  deps.logger.warn(
    'export-google: no connected HTTPS external address — the public hub URL cannot be derived, so the Google console URLs stay unrendered. Set up remote access (Cloudflare Tunnel, Tailscale Funnel, …) and press "Detect external address", or type the URL on the settings form.',
  )
  return []
}

const usableOrigins = (
  candidates: readonly PublicEndpointCandidate[],
  logger: IScopedLogger,
): readonly string[] => {
  const out = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.protocol !== 'https' || candidate.url.length === 0) continue
    const origin = normalisePublicHubUrl(candidate.url)
    if (!isPubliclyRoutableOrigin(origin)) {
      // A dropped candidate is the difference between "nothing was reported"
      // and "something was reported and refused". Both end with an empty field,
      // and only a line here tells them apart.
      logger.info(
        'export-google: ignored an external address that is not reachable from the internet — Google calls the fulfillment URL from its own cloud',
        { meta: { origin } },
      )
      continue
    }
    out.add(origin)
  }
  return [...out]
}

const originsFromListEndpoints = async (
  deps: DetectPublicHubOriginsDeps,
): Promise<readonly string[]> => {
  try {
    return usableOrigins(await deps.network.listEndpoints(), deps.logger)
  } catch (err) {
    deps.logger.debug('export-google: networkAccess.listEndpoints failed', {
      meta: { error: errMsg(err) },
    })
    return []
  }
}

const originFromGetStatus = async (deps: DetectPublicHubOriginsDeps): Promise<string> => {
  try {
    const status = await deps.network.getStatus()
    if (status === null || !status.connected || status.endpoint === null) return ''
    return usableOrigins([status.endpoint], deps.logger)[0] ?? ''
  } catch (err) {
    deps.logger.debug('export-google: networkAccess.getStatus failed', {
      meta: { error: errMsg(err) },
    })
    return ''
  }
}

/**
 * Apply the default-not-override policy.
 *
 * The operator's value is never in the returned patch. Detection's own answer
 * always is, because the settings panel needs it to say "you set this one, and
 * a different one is detected".
 */
export const resolvePublicHubUrl = (
  current: string,
  detected: readonly string[],
): PublicHubUrlResolution => {
  const detectedPublicHubUrl = detected[0] ?? ''
  if (current.length > 0) {
    return {
      patch: { detectedPublicHubUrl },
      publicHubUrl: current,
      detectedPublicHubUrl,
      defaulted: false,
    }
  }
  if (detectedPublicHubUrl.length === 0) {
    return {
      patch: { detectedPublicHubUrl },
      publicHubUrl: '',
      detectedPublicHubUrl,
      defaulted: false,
    }
  }
  return {
    patch: { publicHubUrl: detectedPublicHubUrl, detectedPublicHubUrl },
    publicHubUrl: detectedPublicHubUrl,
    detectedPublicHubUrl,
    defaulted: true,
  }
}

/** Which of the two authored the value currently in the field. */
export const publicHubUrlSource = (state: PublicHubUrlState): PublicHubUrlSource => {
  if (state.publicHubUrl.length === 0) return 'unset'
  if (state.detectedPublicHubUrl.length > 0 && state.publicHubUrl === state.detectedPublicHubUrl) {
    return 'derived'
  }
  return 'operator-set'
}

/**
 * The line under the field. A URL that appeared by itself with no provenance is
 * worse than a blank field: the operator cannot tell whether it is right.
 */
export const buildPublicHubUrlNotice = (state: PublicHubUrlState): PublicHubUrlNotice => {
  switch (publicHubUrlSource(state)) {
    case 'derived':
      return {
        variant: 'info',
        content: `Derived from remote access — ${state.publicHubUrl} is the first HTTPS address the network-access capability reports. Edit the field to override it; nothing here ever overwrites a value you set.`,
      }
    case 'operator-set':
      return {
        variant: 'info',
        content:
          state.detectedPublicHubUrl.length > 0
            ? `Set by you — ${state.publicHubUrl}. The address currently detected from remote access is ${state.detectedPublicHubUrl}; paste it in yourself if you want to switch, detection will not do it for you.`
            : `Set by you — ${state.publicHubUrl}. No external HTTPS address is detected right now, so nothing is corroborating it.`,
      }
    case 'unset':
      return state.detectedPublicHubUrl.length > 0
        ? {
            variant: 'info',
            content: `Detected external address: ${state.detectedPublicHubUrl}. Press "Detect external address" to fill the field with it.`,
          }
        : {
            variant: 'warning',
            content:
              'No public HTTPS address detected — no network-access provider on this hub reports a connected HTTPS endpoint, so there is nothing to derive from. Set up remote access (Cloudflare Tunnel, Tailscale Funnel, …) and press "Detect external address", or type the URL yourself. An address on your own network will not do: Google calls this URL from its own cloud.',
          }
  }
}

/**
 * The `device-export` setup block: the three console URLs plus the
 * linked-account count. All three come off the SAME origin, so they can never
 * disagree with each other.
 */
export const buildConsoleSetup = (input: ConsoleSetupInput): ExportSetup => {
  const origin = normalisePublicHubUrl(input.publicHubUrl)
  const linked = String(input.linkedAccounts)
  if (origin.length === 0) {
    return {
      note: [
        'Set the public hub URL on the settings form first — every URL Google needs is derived from it.',
        buildPublicHubUrlNotice(input).content,
      ].join('\n'),
      fields: [{ label: 'Linked Google accounts', value: linked }],
    }
  }
  return {
    note: [
      'In the Google Home Developer Console create a cloud-to-cloud integration, then paste these three URLs.',
      'The integration stays in test mode: publishing requires Google certification, which a private hub cannot obtain.',
      'This hub pushes nothing to Google — state is read by polling, so a change made outside the Home app appears on the next query, not instantly.',
      buildPublicHubUrlNotice(input).content,
    ].join('\n'),
    fields: [
      { label: 'Fulfillment URL', value: `${origin}/addon/${input.addonId}/fulfillment` },
      {
        label: 'Authorization URL',
        value: `${origin}/api/oauth2/authorize?integration=${input.addonId}`,
      },
      { label: 'Token URL', value: `${origin}/api/oauth2/token` },
      { label: 'Linked Google accounts', value: linked },
    ],
  }
}

/**
 * Detect, apply the policy, persist, and say out loud what happened.
 *
 * Every branch here logs: a fill names the URL it picked and the source it came
 * from, and a miss that leaves the field empty says so rather than passing for
 * "never ran".
 */
export const refreshPublicHubUrl = async (
  deps: RefreshPublicHubUrlDeps,
): Promise<PublicHubUrlResolution> => {
  const detected = await deps.detect()
  const resolution = resolvePublicHubUrl(deps.current().publicHubUrl, detected)
  await deps.persist(resolution.patch)

  if (resolution.defaulted) {
    deps.logger.info('export-google: defaulted public hub URL to the detected external address', {
      meta: { publicHubUrl: resolution.publicHubUrl, source: 'network-access' },
    })
  } else if (resolution.publicHubUrl.length === 0) {
    deps.logger.warn(
      'export-google: public hub URL still unset after detection — the Google console URLs cannot be rendered until one is available',
      { meta: { detectedCount: detected.length } },
    )
  }
  return resolution
}

/** What "Detect external address" did, in one sentence for the button. */
export function describeDetectResult(result: {
  readonly publicHubUrl: string
  readonly detectedPublicHubUrl: string
  readonly filled: boolean
}): string {
  const { publicHubUrl, detectedPublicHubUrl, filled } = result
  if (filled) return `Filled in ${publicHubUrl}.`
  if (detectedPublicHubUrl.length === 0) {
    return publicHubUrl.length > 0
      ? `No public HTTPS address detected; your value ${publicHubUrl} was kept.`
      : 'No public HTTPS address detected. Set up remote access first.'
  }
  if (detectedPublicHubUrl === publicHubUrl) return `Detected ${publicHubUrl}, already in use.`
  return `Detected ${detectedPublicHubUrl}; your value ${publicHubUrl} was kept.`
}
