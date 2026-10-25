/**
 * Skill credentials, read where they live: SSM Parameter Store SecureString
 * parameters, decrypted with the AWS-managed `aws/ssm` key (D753, D761).
 *
 * Two credential pairs exist, and they authenticate DIFFERENT parties:
 *
 *   lwa    The skill's "Send Alexa Events" (Alexa Skill Messaging) LWA client.
 *          Authenticates THIS Lambda to api.amazon.com when it exchanges an
 *          AcceptGrant code and when it refreshes a user's grant. It is the
 *          one that must never leave the Lambda.
 *   skill  The account-linking client id/secret typed into the skill's
 *          Account Linking page. Authenticates AMAZON to this Lambda's
 *          `/token` route. Amazon holds a copy; nothing else needs one.
 *
 * Each parameter's value is a JSON string
 * `{"clientId": "...", "clientSecret": "..."}`.
 * `skill` may also carry `previousClientSecret`, accepted on `/token` while a
 * rotation is in flight (change Amazon's copy, then drop the previous one).
 *
 * Resolution, per pair:
 *   1. `<KIND>_PARAM` set   → that SSM parameter (read with decryption),
 *                             cached for `ttlMs`.
 *   2. otherwise            → the legacy plain env vars
 *                             (`LWA_CLIENT_ID`/`LWA_CLIENT_SECRET`,
 *                             `SKILL_CLIENT_ID`/`SKILL_CLIENT_SECRET`), so this
 *                             code can be deployed before the parameters exist
 *                             and the cut-over has no downtime.
 *
 * The cache is what makes a rotation cheap: a new value is picked up within
 * `ttlMs`, and immediately when LWA answers `invalid_client` (the caller calls
 * `invalidate`). Error messages name the parameter, never a value.
 */
'use strict'

const DEFAULT_SECRET_TTL_MS = 5 * 60 * 1000

const KINDS = {
  lwa: { paramVar: 'LWA_PARAM', idVar: 'LWA_CLIENT_ID', secretVar: 'LWA_CLIENT_SECRET' },
  skill: {
    paramVar: 'SKILL_PARAM',
    idVar: 'SKILL_CLIENT_ID',
    secretVar: 'SKILL_CLIENT_SECRET',
  },
}

/**
 * @param {object} opts
 * @param {Record<string, string|undefined>} opts.env
 * @param {(name: string) => Promise<string>} opts.readParameter  decrypted value
 * @param {() => number} [opts.now]
 * @param {number} [opts.ttlMs]
 */
function createSecretSource(opts) {
  const env = opts.env
  const now = opts.now || Date.now
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_SECRET_TTL_MS
  const cache = new Map()

  async function load(kind) {
    const spec = KINDS[kind]
    const paramName = env[spec.paramVar]
    if (paramName) {
      const hit = cache.get(kind)
      if (hit && now() - hit.at < ttlMs) return hit.value
      const raw = await opts.readParameter(paramName)
      const value = parseCredentialParameter(raw, paramName)
      cache.set(kind, { value, at: now() })
      return value
    }
    const clientId = env[spec.idVar]
    const clientSecret = env[spec.secretVar]
    if (clientId && clientSecret) return { clientId, clientSecret, source: 'env' }
    return null
  }

  return {
    lwa: () => load('lwa'),
    skill: () => load('skill'),
    invalidate: (kind) => {
      cache.delete(kind)
    },
  }
}

function parseCredentialParameter(raw, paramName) {
  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new Error(`parameter ${paramName} is not a JSON object`)
  }
  if (
    !obj ||
    typeof obj.clientId !== 'string' ||
    obj.clientId.length === 0 ||
    typeof obj.clientSecret !== 'string' ||
    obj.clientSecret.length === 0
  ) {
    throw new Error(`parameter ${paramName} must be {"clientId": "...", "clientSecret": "..."}`)
  }
  const out = { clientId: obj.clientId, clientSecret: obj.clientSecret, source: 'ssm' }
  if (typeof obj.previousClientSecret === 'string' && obj.previousClientSecret.length > 0) {
    out.previousClientSecret = obj.previousClientSecret
  }
  return out
}

module.exports = { createSecretSource, parseCredentialParameter, DEFAULT_SECRET_TTL_MS }
