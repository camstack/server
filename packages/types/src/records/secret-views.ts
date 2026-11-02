/**
 * A stored secret, as an admin read shows it: a VIEW naming the row's own
 * keychain ref (`set: true`), never the value and no longer the bare redaction
 * token. The form hands it to the secret field, which reveals the value by ref
 * through the audited `keychain-admin.reveal`; sent back untouched it keeps the
 * stored secret (the records door reads a view as KEEP).
 *
 * ONE implementation for the entries service and for every addon that serves
 * its own instances (`RecordIntegrationInstances`).
 */
import { REDACTED_SECRET } from '../interfaces/config-ui-secrets.js'
import type { SecretFieldView } from '../keychain/secret-marker.js'
import type { RecordKindDeclaration } from './record-kind.js'
import { mapSecretLeaves, recordSecretRef } from './secret-paths.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The part of a kind's declaration that names its secret fields. */
export type SecretDeclaration = Pick<RecordKindDeclaration, 'secretPaths' | 'secretArrayKeys'>

export function secretViewsOf(
  owner: string,
  kind: string,
  id: string,
  decl: SecretDeclaration,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (decl.secretPaths.length === 0) return data
  const shown = mapSecretLeaves(data, decl.secretPaths, decl.secretArrayKeys, (leaf) => {
    if (leaf.value !== REDACTED_SECRET) return leaf.value
    const view: SecretFieldView = {
      $secret: recordSecretRef(owner, kind, id, leaf.concrete),
      v: 1,
      set: true,
    }
    return view
  })
  return isRecord(shown) ? shown : data
}
