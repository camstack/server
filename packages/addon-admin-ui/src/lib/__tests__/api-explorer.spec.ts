/**
 * The API explorer's pure half (planning#595): the input skeleton, the check
 * before sending, the curl line in the hub's wire format, the typed error.
 */
import { describe, expect, it } from 'vitest'
import {
  apiCallErrorOf,
  buildCurl,
  checkInputAgainstSchema,
  parseInputText,
  skeletonFromSchema,
} from '../api-explorer'

const SCHEMA = {
  type: 'object',
  properties: {
    deviceId: { type: 'integer', minimum: 1 },
    mode: { type: 'string', enum: ['on', 'off'] },
    limit: { type: 'integer', default: 10 },
    filter: { $ref: '#/$defs/Filter' },
    note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['deviceId', 'mode', 'filter'],
  additionalProperties: false,
  $defs: {
    Filter: {
      type: 'object',
      properties: { kinds: { type: 'array', items: { type: 'string' } } },
      required: ['kinds'],
    },
  },
} as const

describe('skeletonFromSchema', () => {
  it('fills only the required fields: minimum, first enum value, empty value of the type, $ref resolved', () => {
    expect(skeletonFromSchema(SCHEMA)).toEqual({ deviceId: 1, mode: 'on', filter: { kinds: [] } })
    // The skeleton passes the check it is shown under.
    expect(checkInputAgainstSchema(skeletonFromSchema(SCHEMA), SCHEMA)).toEqual([])
  })

  it('uses a default when the schema names one', () => {
    expect(
      skeletonFromSchema({
        type: 'object',
        properties: { limit: { type: 'integer', default: 10 } },
        required: ['limit'],
      }),
    ).toEqual({ limit: 10 })
  })

  it('a nullable union starts from its non-null branch', () => {
    expect(skeletonFromSchema({ anyOf: [{ type: 'null' }, { type: 'string' }] })).toBe('')
  })

  it('no schema means no input', () => {
    expect(skeletonFromSchema(null)).toBeUndefined()
  })
})

describe('checkInputAgainstSchema', () => {
  it('passes a valid input', () => {
    expect(
      checkInputAgainstSchema(
        { deviceId: 3, mode: 'off', filter: { kinds: ['a'] }, note: null },
        SCHEMA,
      ),
    ).toEqual([])
  })

  it('names every problem with its path', () => {
    const issues = checkInputAgainstSchema(
      { deviceId: 0, mode: 'dim', filter: { kinds: [1] }, extra: true },
      SCHEMA,
    )
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'deviceId', code: 'minimum', expected: '1' },
        { path: 'mode', code: 'enum', expected: '"on", "off"' },
        { path: 'filter.kinds.0', code: 'type', expected: 'string' },
        { path: 'extra', code: 'unknown-field', expected: 'extra' },
      ]),
    )
  })

  it('a missing required field and a wrong root type are refused', () => {
    expect(checkInputAgainstSchema({ mode: 'on', filter: { kinds: [] } }, SCHEMA)).toEqual([
      { path: 'deviceId', code: 'required', expected: 'deviceId' },
    ])
    expect(checkInputAgainstSchema([], SCHEMA)).toEqual([
      { path: '', code: 'type', expected: 'object' },
    ])
  })

  it('a value no union branch accepts is refused', () => {
    expect(
      checkInputAgainstSchema({ deviceId: 1, mode: 'on', filter: { kinds: [] }, note: 5 }, SCHEMA),
    ).toEqual([{ path: 'note', code: 'no-branch', expected: '2' }])
  })
})

describe('parseInputText', () => {
  it('blank is no input; bad JSON is a message', () => {
    expect(parseInputText('  ')).toEqual({ ok: true, value: undefined })
    expect(parseInputText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseInputText('{a')).toMatchObject({ ok: false })
  })
})

describe('buildCurl', () => {
  const hubBase = 'https://hub.example.com/camstack'

  it('a query is a GET with the input in the superjson envelope', () => {
    const curl = buildCurl({ hubBase, path: 'addons.list', kind: 'query', input: { a: 1 } })
    expect(curl).toContain('-H "Authorization: Bearer $CAMSTACK_TOKEN"')
    expect(curl).toContain(
      `'https://hub.example.com/camstack/trpc/addons.list?input=${encodeURIComponent('{"json":{"a":1}}')}'`,
    )
    expect(curl).not.toContain('-X POST')
  })

  it('a query without input has no ?input', () => {
    expect(buildCurl({ hubBase, path: 'system.info', kind: 'query', input: undefined })).toContain(
      `'https://hub.example.com/camstack/trpc/system.info'`,
    )
  })

  it('a mutation is a POST with the envelope as body, quoted for the shell', () => {
    const curl = buildCurl({ hubBase, path: 'x.set', kind: 'mutation', input: { name: "it's" } })
    expect(curl).toContain('-X POST')
    expect(curl).toContain(`--data '{"json":{"name":"it'\\''s"}}'`)
    expect(curl).toContain(`'https://hub.example.com/camstack/trpc/x.set'`)
  })
})

describe('apiCallErrorOf', () => {
  it('reads the typed fields of a tRPC client error', () => {
    const err = Object.assign(new Error('no provider'), {
      data: { code: 'NOT_FOUND', httpStatus: 404, path: 'a.b', capRouteReason: 'no-provider' },
    })
    expect(apiCallErrorOf(err)).toEqual({
      message: 'no provider',
      code: 'NOT_FOUND',
      httpStatus: 404,
      path: 'a.b',
      capRouteReason: 'no-provider',
    })
  })

  it('a plain error has only its message', () => {
    expect(apiCallErrorOf(new Error('boom'))).toEqual({
      message: 'boom',
      code: null,
      httpStatus: null,
      path: null,
      capRouteReason: null,
    })
  })
})
