/**
 * The Unraid connection test (planning#581): sign in with the API key as the form holds it — the
 * client's `connect()` is one authenticated read — and answer a typed verdict with a reason.
 */
import { errMsg, type IntegrationTestConnectionResult } from '@camstack/types'
import type { UnraidConnectionConfig } from './config.js'
import type { UnraidClientFactory } from './unraid-client-contract.js'
import { UnraidClientError } from './unraid-client-live.js'

/** The verdict for a failed connect: a refusal blocks creation, an unanswered call does not. */
function failureOf(err: unknown): IntegrationTestConnectionResult {
  if (err instanceof UnraidClientError && err.kind === 'auth') {
    return {
      success: false,
      status: 'rejected',
      error: `unraid: the server refused the API key (${err.message}) — it needs the ADMIN role`,
    }
  }
  if (err instanceof UnraidClientError && err.kind === 'api') {
    return {
      success: false,
      status: 'inconclusive',
      error: `unraid: the API answered an error: ${err.message}`,
    }
  }
  return {
    success: false,
    status: 'inconclusive',
    error: `unraid: the server did not answer (${errMsg(err)}) — check the host, the port and https`,
  }
}

export async function testUnraidConnection(
  connection: UnraidConnectionConfig,
  makeClient: UnraidClientFactory,
): Promise<IntegrationTestConnectionResult> {
  if (connection.apiKey === '') {
    return {
      success: false,
      status: 'rejected',
      error: 'unraid: enter an API key',
    }
  }
  const started = Date.now()
  try {
    const client = makeClient(connection)
    try {
      await client.connect()
      return {
        success: true,
        status: 'validated',
        latencyMs: Date.now() - started,
      }
    } finally {
      await client.disconnect().catch((): null => null)
    }
  } catch (err) {
    return failureOf(err)
  }
}
