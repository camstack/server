/**
 * The VeSync connection test (planning#581): sign in ONCE with the credentials as the form holds
 * them and answer a typed verdict with a reason. A refusal the operator can fix (password, region)
 * blocks creation; a cloud that did not answer, or anything the library does not explain, is
 * inconclusive and carries the library's own words.
 */
import { errMsg, type IntegrationTestConnectionResult } from '@camstack/types'
import type { VeSyncConnectionConfig } from './config.js'
import type { VeSyncClientFactory } from './vesync-client-contract.js'
import { VeSyncLoginError } from './vesync-tsvesync-client.js'

/** The verdict for a failed sign-in. */
function failureOf(err: unknown, region: string): IntegrationTestConnectionResult {
  if (!(err instanceof VeSyncLoginError)) {
    return {
      success: false,
      status: 'inconclusive',
      error: `vesync: the sign-in did not complete (${errMsg(err)})`,
    }
  }
  switch (err.kind) {
    case 'credentials':
      return {
        success: false,
        status: 'rejected',
        error: `vesync: VeSync refused the email or password (${err.words})`,
      }
    case 'region':
      return {
        success: false,
        status: 'rejected',
        error: `vesync: neither the US nor the EU VeSync region accepts this account (region set: ${region}) — ${err.words}`,
      }
    case 'unreachable':
      return {
        success: false,
        status: 'inconclusive',
        error: `vesync: could not reach the VeSync cloud (${err.words})`,
      }
    case 'refused':
      return {
        success: false,
        status: 'inconclusive',
        error: `vesync: VeSync did not accept the sign-in: ${err.words}`,
      }
  }
}

export async function testVeSyncConnection(
  connection: VeSyncConnectionConfig,
  makeClient: VeSyncClientFactory,
): Promise<IntegrationTestConnectionResult> {
  if (connection.password === '') {
    return { success: false, status: 'rejected', error: 'vesync: enter the account password' }
  }
  const started = Date.now()
  try {
    const client = makeClient({
      email: connection.email,
      password: connection.password,
      region: connection.region,
    })
    try {
      await client.login()
      return { success: true, status: 'validated', latencyMs: Date.now() - started }
    } finally {
      await client.logout().catch((): null => null)
    }
  } catch (err) {
    return failureOf(err, connection.region)
  }
}
