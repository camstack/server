/**
 * Broker link store — one DynamoDB item per hub link (D753).
 *
 * Table `camstack-alexa-tokens` (name from `TOKENS_TABLE`), partition key
 * `linkId` (S), TTL attribute `ttl` (epoch SECONDS), encrypted at rest (SSE,
 * KMS). An item is the Lambda's half of one hub's Alexa push grant:
 *
 *   linkId           random 128-bit id — the public half of the hub credential
 *   secretHash       sha256(hex) of the credential's secret half; the secret
 *                    itself is never stored
 *   status           'pending' (AcceptGrant in flight) | 'active'
 *   refreshToken     the user's LWA refresh token — NEVER leaves the Lambda
 *   accessToken      cached LWA access token (handed to the hub on request)
 *   accessExpiresAt  ms epoch
 *   hubUrl           informational: the hub the link was made for
 *   origin           'accept-grant' | 'migration'
 *   createdAt, lastUsedAt  ms epoch
 *   ttl              s epoch; pending links expire in 1h, active ones after
 *                    an idle period (bumped on every refresh)
 *   version          optimistic-concurrency counter; every write is
 *                    conditional on it, so two concurrent refreshes never
 *                    clobber each other's rotated refresh token
 *
 * The store is an interface (`get`/`create`/`replace`/`remove`) so the broker
 * is tested against an in-memory implementation and the DynamoDB marshalling
 * is tested on its own.
 */
'use strict'

const STRING_FIELDS = [
  'linkId',
  'secretHash',
  'status',
  'refreshToken',
  'accessToken',
  'hubUrl',
  'origin',
]
const NUMBER_FIELDS = ['accessExpiresAt', 'createdAt', 'lastUsedAt', 'ttl', 'version']

function marshal(item) {
  const out = {}
  for (const k of STRING_FIELDS) {
    if (typeof item[k] === 'string') out[k] = { S: item[k] }
  }
  for (const k of NUMBER_FIELDS) {
    if (typeof item[k] === 'number' && Number.isFinite(item[k])) out[k] = { N: String(item[k]) }
  }
  return out
}

function unmarshal(raw) {
  if (!raw) return null
  const out = {}
  for (const k of STRING_FIELDS) {
    if (raw[k] && typeof raw[k].S === 'string') out[k] = raw[k].S
  }
  for (const k of NUMBER_FIELDS) {
    if (raw[k] && typeof raw[k].N === 'string') out[k] = Number(raw[k].N)
  }
  return out
}

function isConditionalFailure(err) {
  return Boolean(err) && err.name === 'ConditionalCheckFailedException'
}

/**
 * @param {object} opts
 * @param {(command: 'GetItem'|'PutItem'|'DeleteItem', input: object) => Promise<any>} opts.send
 * @param {string} opts.tableName
 */
function createDynamoTokenStore(opts) {
  const TableName = opts.tableName
  const send = opts.send
  return {
    async get(linkId) {
      const res = await send('GetItem', {
        TableName,
        Key: { linkId: { S: linkId } },
        ConsistentRead: true,
      })
      return unmarshal(res && res.Item)
    },
    async create(item) {
      await send('PutItem', {
        TableName,
        Item: marshal(item),
        ConditionExpression: 'attribute_not_exists(linkId)',
      })
    },
    /** Replace the whole item iff its stored version is `expectedVersion`. */
    async replace(item, expectedVersion) {
      try {
        await send('PutItem', {
          TableName,
          Item: marshal(item),
          ConditionExpression: 'version = :v',
          ExpressionAttributeValues: { ':v': { N: String(expectedVersion) } },
        })
        return true
      } catch (err) {
        if (isConditionalFailure(err)) return false
        throw err
      }
    },
    async remove(linkId) {
      await send('DeleteItem', { TableName, Key: { linkId: { S: linkId } } })
    },
  }
}

/** In-memory store with the same contract — tests, and local runs. */
function createMemoryTokenStore() {
  const items = new Map()
  return {
    items,
    async get(linkId) {
      const it = items.get(linkId)
      return it ? { ...it } : null
    },
    async create(item) {
      if (items.has(item.linkId)) {
        const err = new Error('exists')
        err.name = 'ConditionalCheckFailedException'
        throw err
      }
      items.set(item.linkId, { ...item })
    },
    async replace(item, expectedVersion) {
      const cur = items.get(item.linkId)
      if (!cur || cur.version !== expectedVersion) return false
      items.set(item.linkId, { ...item })
      return true
    },
    async remove(linkId) {
      items.delete(linkId)
    },
  }
}

module.exports = { createDynamoTokenStore, createMemoryTokenStore, marshal, unmarshal }
