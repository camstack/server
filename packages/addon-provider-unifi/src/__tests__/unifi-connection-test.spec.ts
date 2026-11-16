/**
 * The UniFi connection test and status (planning#581): the integration declares a real test, it
 * signs in with the API key the form holds (a saved secret stands in for its redacted view), and every
 * failure names a reason the operator can act on — on the test verdict and on the status.
 */
import { makeInMemoryRecords, REDACTED_SECRET, type IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { settingsToConnection } from '../config.js'
import type {
  UnifiControllerClient,
  UnifiControllerClientFactory,
} from '../unifi-client-contract.js'
import { makeUnifiClientFactory } from '../unifi-client-factory.js'
import { UnifiClientRegistry } from '../unifi-client-registry.js'
import { classifyUnifiError, testUnifiConnection } from '../unifi-connection-test.js'
import { UnifiAuthError, UnifiNoCredentialError, UnifiSiteNotFoundError } from '../unifi-errors.js'
import {
  buildUnifiInstances,
  unifiConnectionsEntryKind,
  unifiRecordKinds,
} from '../unifi-instances.js'
import { infraSnapshot } from './unifi-fixtures.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

type ClientInput = Parameters<UnifiControllerClientFactory>[0]

/** A client whose connect fails with `failure`, or succeeds with one device. */
function fakeFactory(failure: unknown, seen: ClientInput[] = []): UnifiControllerClientFactory {
  return (input) => {
    seen.push(input)
    const client: UnifiControllerClient = {
      connect: async () => {
        if (failure !== null) throw failure
      },
      disconnect: async () => undefined,
      listInfraDevices: async () => [
        infraSnapshot({
          id: 'd1',
          name: 'Switch',
          model: 'USW',
          kind: 'switch',
          ledOn: true,
        }),
      ],
      listClients: async () => [],
      getInfraDevice: () => null,
      getClient: () => null,
      setPortPoe: async () => undefined,
      restartDevice: async () => undefined,
      powerCyclePort: async () => undefined,
      setLed: async () => undefined,
      degradedError: () => null,
      onLiveChange: () => () => undefined,
    }
    return client
  }
}

function socketError(code: string): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(code), { code }),
  })
}

const KEYED = settingsToConnection({
  host: 'console.example',
  apiKey: 'k',
})

describe('classifyUnifiError', () => {
  it.each<[string, unknown, string]>([
    ['no-credential', new UnifiNoCredentialError(), 'API key'],
    [
      'bad-credentials',
      new UnifiAuthError('unifi: the console refused the API key (HTTP 401)'),
      'refused the API key',
    ],
    ['wrong-site', new UnifiSiteNotFoundError('office', ['default']), 'the console has: default'],
    ['tls', socketError('DEPTH_ZERO_SELF_SIGNED_CERT'), 'Accept self-signed certificate'],
    ['unreachable', socketError('ECONNREFUSED'), 'host and the HTTPS port'],
    ['unreachable', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'ETIMEDOUT'],
  ])('names %s', (kind, err, words) => {
    const failure = classifyUnifiError(err)
    expect(failure.kind).toBe(kind)
    expect(failure.reason).toContain(words)
  })
})

describe('testUnifiConnection', () => {
  it('validates and says the API key signed in', async () => {
    const result = await testUnifiConnection(KEYED, fakeFactory(null))
    expect(result).toMatchObject({ success: true, status: 'validated' })
    expect(result.detail).toContain('API key')
  })

  it('a refusal blocks creation, with the reason', async () => {
    const result = await testUnifiConnection(
      KEYED,
      fakeFactory(new UnifiAuthError('unifi: the console refused the API key (HTTP 401)')),
    )
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toContain('refused the API key')
  })

  it('a self-signed console is named, with the switch to turn on — never "fetch failed"', async () => {
    const result = await testUnifiConnection(
      KEYED,
      fakeFactory(socketError('DEPTH_ZERO_SELF_SIGNED_CERT')),
    )
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toContain('turn on "Accept self-signed certificate"')
    expect(result.error).not.toContain('fetch failed')
  })

  it('a username without a password is no credential: refused before any request', async () => {
    const mustNotCall = async (): Promise<never> => {
      throw new Error('must not be called')
    }
    const result = await testUnifiConnection(
      settingsToConnection({ host: 'console.example', username: 'u' }),
      makeUnifiClientFactory({
        fetchFor: () => mustNotCall,
        openWorker: mustNotCall,
        secretFiles: mustNotCall,
      }),
    )
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(result.error).toContain('no credential')
  })

  it('an unreachable controller is inconclusive, not a refusal', async () => {
    const result = await testUnifiConnection(KEYED, fakeFactory(socketError('EHOSTUNREACH')))
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
  })
})

describe('the UniFi integration declares and runs its test', () => {
  async function world(failure: unknown, seen: ClientInput[] = []) {
    const mem = makeInMemoryRecords('provider-unifi')
    await mem.records.declare(unifiRecordKinds)
    const instances = buildUnifiInstances(mem.records, {
      onChanged: async () => undefined,
      makeClient: fakeFactory(failure, seen),
      statusOf: () => null,
    })
    return { mem, instances }
  }

  it('offers a Test (canTest), on the integration and its kind', async () => {
    const { instances } = await world(null)
    const description = await instances.describe()
    expect(description.canTest).toBe(true)
    expect(description.kinds?.map((k) => k.canTest ?? description.canTest)).toEqual([true])
  })

  it('tests a draft with the typed API key', async () => {
    const seen: ClientInput[] = []
    const { instances } = await world(null, seen)
    const result = await instances.testInstance({
      id: null,
      values: {
        host: 'console.example',
        apiKey: 'typed',
      },
    })
    expect(result.status).toBe('validated')
    expect(seen[0]).toMatchObject({ apiKey: 'typed' })
  })

  it('a saved API key stands in for its redacted view', async () => {
    const seen: ClientInput[] = []
    const { mem, instances } = await world(null, seen)
    await mem.records.kind(unifiConnectionsEntryKind).put({
      id: 'int_1',
      data: {
        name: 'Home',
        host: 'console.example',
        apiKey: 'stored',
      },
    })
    await instances.testInstance({
      id: 'int_1',
      values: {
        host: 'console.example',
        apiKey: REDACTED_SECRET,
      },
    })
    expect(seen[0]?.apiKey).toBe('stored')
  })
})

describe('the integration status names why it is offline', () => {
  it('an integration with no credential is offline with the reason, not silently empty', async () => {
    const registry = new UnifiClientRegistry(quiet, {
      makeClient: fakeFactory(new UnifiNoCredentialError()),
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
    })
    await registry.upsert('int_1', 'Home', settingsToConnection({ host: 'console.example' }), false)
    expect(registry.statusOf('int_1')).toMatchObject({
      state: 'error',
      label: 'Offline',
    })
    expect(registry.statusOf('int_1')?.detail).toContain('no credential')
    await registry.shutdown()
  })

  it('a connected integration says the API key signed in', async () => {
    const registry = new UnifiClientRegistry(quiet, {
      makeClient: fakeFactory(null),
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: () => undefined,
    })
    await registry.upsert('int_1', 'Home', KEYED, false)
    expect(registry.statusOf('int_1')).toEqual({
      state: 'ok',
      label: 'Connected',
      detail: 'Signed in with the API key',
    })
    await registry.shutdown()
  })
})
