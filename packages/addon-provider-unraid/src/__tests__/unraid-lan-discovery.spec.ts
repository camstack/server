import { DeviceType, type DiscoveryHit } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  isUnraidGraphqlAnswer,
  UNRAID_DISCOVERY_MODES,
  unraidServerCandidates,
  unraidServersFromHits,
} from '../unraid-lan-discovery.js'

const ANSWER = JSON.stringify({ data: { __type: { name: 'UnraidArray' } } })

const hit = (host: string, port: number, bodyText: string, status = 200): DiscoveryHit => ({
  modeIndex: port === 80 ? 0 : 1,
  host,
  port,
  http: { status, headers: {}, bodyText },
})

describe('UNRAID_DISCOVERY_MODES', () => {
  it('asks for the Unraid-only UnraidArray type of /graphql on 80 plain and 443 over TLS', () => {
    const body = JSON.stringify({ query: '{__type(name:"UnraidArray"){name}}' })
    expect(UNRAID_DISCOVERY_MODES).toEqual([
      {
        kind: 'http-probe',
        port: 80,
        path: '/graphql',
        method: 'POST',
        bodyText: body,
        contentType: 'application/json',
        tls: false,
        acceptStatus: [200],
      },
      {
        kind: 'http-probe',
        port: 443,
        path: '/graphql',
        method: 'POST',
        bodyText: body,
        contentType: 'application/json',
        tls: true,
        acceptStatus: [200],
      },
    ])
  })
})

describe('isUnraidGraphqlAnswer', () => {
  it('accepts only an answer that knows the UnraidArray type', () => {
    // Any GraphQL server answers {__typename}; a non-Unraid schema answers __type: null.
    expect(isUnraidGraphqlAnswer(200, JSON.stringify({ data: { __typename: 'Query' } }))).toBe(
      false,
    )
    expect(isUnraidGraphqlAnswer(200, JSON.stringify({ data: { __type: null } }))).toBe(false)
    expect(isUnraidGraphqlAnswer(200, ANSWER)).toBe(true)
    expect(isUnraidGraphqlAnswer(401, ANSWER)).toBe(false)
    expect(isUnraidGraphqlAnswer(200, '<html>login</html>')).toBe(false)
    expect(isUnraidGraphqlAnswer(200, JSON.stringify({ errors: [{ message: 'nope' }] }))).toBe(
      false,
    )
    expect(isUnraidGraphqlAnswer(200, 'null')).toBe(false)
  })
})

describe('unraidServersFromHits', () => {
  it('keeps one server per host, plain http when both ports answered, and drops other answers', () => {
    const scan = unraidServersFromHits([
      hit('192.0.2.20', 443, ANSWER),
      hit('192.0.2.20', 80, ANSWER),
      hit('192.0.2.21', 443, ANSWER),
      hit('192.0.2.30', 80, '{"ok":true}'),
    ])
    expect(scan.servers).toEqual([
      { host: '192.0.2.20', port: 80, https: false },
      { host: '192.0.2.21', port: 443, https: true },
    ])
    expect(scan.dropped).toEqual([{ host: '192.0.2.30', port: 80, reason: 'not-graphql' }])
  })
})

describe('unraidServerCandidates', () => {
  const servers = [
    { host: '192.0.2.20', port: 80, https: false },
    { host: '192.0.2.21', port: 443, https: true },
  ]

  it('offers a server as an integration to set up, named after its host, connection prefilled', () => {
    expect(unraidServerCandidates(servers, []).candidates).toEqual([
      {
        stableId: 'unraid-server:192.0.2.20',
        type: DeviceType.Gateway,
        suggestedName: 'Unraid - 192.0.2.20',
        prefilledConfig: { host: '192.0.2.20', port: 80, https: false, allowSelfSigned: false },
        setupIntegration: true,
      },
      {
        stableId: 'unraid-server:192.0.2.21',
        type: DeviceType.Gateway,
        suggestedName: 'Unraid - 192.0.2.21',
        prefilledConfig: { host: '192.0.2.21', port: 443, https: true, allowSelfSigned: true },
        setupIntegration: true,
      },
    ])
  })

  it('leaves out a server an integration already dials, and says so', () => {
    const result = unraidServerCandidates(servers, ['192.0.2.21'])
    expect(result.candidates.map((c) => c.stableId)).toEqual(['unraid-server:192.0.2.20'])
    expect(result.dropped).toEqual([{ host: '192.0.2.21', port: 443, reason: 'already-added' }])
  })
})
