import { HOMECOM_GATEWAYS_PATH, HOMECOM_POINTT_API_ORIGIN } from './config.js'
import type { FetchFn, HomeComGatewayListing } from './homecom-api-client.js'
import { HomeComGatewayListError, parseHomeComGatewayList } from './homecom-api-client.js'
import {
  resolveHomeComGateway,
  type HomeComGatewayChoice,
  type HomeComGatewayResolution,
} from './homecom-gateway-pick.js'
import {
  beginHomeComSignIn,
  completeHomeComSignIn,
  HomeComLoginError,
  type HomeComSignInTokens,
} from './homecom-login.js'
import {
  createSignInAttemptStore,
  loginFailureForAttempt,
  type SignInAttemptStore,
} from '../shared/sign-in-attempt.js'

export interface HomeComPublishedSignIn {
  readonly attemptId: string
  readonly authorizeUrl: string
}

export interface HomeComFinishedSignIn extends HomeComSignInTokens {
  readonly accountLabel: string
  readonly gatewayCount: number
  readonly summary: string
  readonly gatewayId?: string
  readonly brand?: HomeComGatewayChoice['brand']
  readonly region?: HomeComGatewayChoice['region']
  readonly choices?: HomeComGatewayChoice[]
}

/** What the form is allowed to see: the URL and an attempt id. Not the verifier. */
export function publishHomeComSignIn(
  store: SignInAttemptStore,
  nowMs: number,
): HomeComPublishedSignIn {
  const started = beginHomeComSignIn()
  const attemptId = store.put(started.verifier, started.state, nowMs)
  return { attemptId, authorizeUrl: started.authorizeUrl }
}

async function listGatewaysDefault(
  tokens: HomeComSignInTokens,
  fetchFn: FetchFn,
): Promise<readonly HomeComGatewayListing[]> {
  const res = await fetchFn(`${HOMECOM_POINTT_API_ORIGIN}${HOMECOM_GATEWAYS_PATH}`, {
    headers: { Authorization: `Bearer ${tokens.token}`, Accept: 'application/json' },
  })
  if (res.status === 401) throw new HomeComGatewayListError(res.status)
  if (!res.ok) throw new HomeComGatewayListError(res.status)
  return parseHomeComGatewayList(await res.json())
}

export async function finishHomeComSignIn(
  input: { readonly attemptId: string; readonly callback: string; readonly nowMs: number },
  store: SignInAttemptStore,
  deps: {
    readonly fetchFn?: FetchFn
    readonly listGateways?: (
      tokens: HomeComSignInTokens,
    ) => Promise<readonly HomeComGatewayListing[]>
  } = {},
): Promise<HomeComFinishedSignIn> {
  const taken = store.take(input.attemptId, input.nowMs)
  if (!taken.ok) throw new HomeComLoginError(loginFailureForAttempt(taken.reason))
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis)
  const tokens = await completeHomeComSignIn(
    { verifier: taken.attempt.verifier, callback: input.callback, state: taken.attempt.state },
    fetchFn,
  )
  let gateways: readonly HomeComGatewayListing[] = []
  let listFailure: string | null = null
  try {
    const list = deps.listGateways ?? ((next) => listGatewaysDefault(next, fetchFn))
    gateways = await list(tokens)
  } catch (err) {
    listFailure = err instanceof HomeComGatewayListError ? err.message : 'The gateway list failed.'
    gateways = []
  }
  return finishedFromGateways(tokens, resolveHomeComGateway(gateways), listFailure)
}

function finishedFromGateways(
  tokens: HomeComSignInTokens,
  resolved: HomeComGatewayResolution,
  listFailure: string | null,
): HomeComFinishedSignIn {
  const who = tokens.username.length > 0 ? `Signed in as ${tokens.username}` : 'Signed in'
  const base = { ...tokens, accountLabel: tokens.username }
  if (listFailure !== null) {
    return {
      ...base,
      gatewayCount: 0,
      summary: listFailure,
    }
  }
  if (resolved.kind === 'one') {
    return {
      ...base,
      gatewayCount: 1,
      gatewayId: resolved.gatewayId,
      brand: resolved.brand,
      region: resolved.region,
      summary: `${who}. Gateway ${resolved.gatewayId} selected.`,
    }
  }
  if (resolved.kind === 'many') {
    return {
      ...base,
      gatewayCount: resolved.options.length,
      choices: resolved.options.map((row) => ({ ...row })),
      summary: `${who}. Choose a gateway.`,
    }
  }
  return {
    ...base,
    gatewayCount: 0,
    summary: 'This Bosch account has no HomeCom gateway.',
  }
}

export const homeComSignInAttempts = createSignInAttemptStore()
