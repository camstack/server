/**
 * The Blocks integration as an `integration-instances` provider (epic #440): the fixed builtin
 * `DeclaredDevices` mints for `core-blocks` (`blocks-integration.ts`) has an instance record under
 * its registry id, holding only its name. It is name-only on purpose: the integration's `enabled`
 * switch stays in the registry (a fixed builtin is switched through `integrations.update`, and
 * `integrations.list` never projects it from a record), and there is nothing to configure.
 */
import {
  defineEntryKind,
  entryBody,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import type { z } from 'zod'

export const blocksConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Blocks integration',
  schema: entryBody({}),
  writeTrigger: 'the hub declares the Blocks integration on boot',
})
export type BlocksConnectionBody = z.infer<typeof blocksConnectionsEntryKind.schema>

/** Every kind of the Blocks integration record, keyed by its name. */
export const blocksInstanceRecordKinds = { connections: blocksConnectionsEntryKind } as const

export function buildBlocksInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<BlocksConnectionBody> {
  return new RecordIntegrationInstances<BlocksConnectionBody>(records, blocksConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'none', scopedToInstance: false },
      instanceMode: 'single',
      kind: 'blocks',
      canTest: false,
      kinds: [{ id: 'blocks', label: 'Blocks', functionCap: 'core-blocks', role: 'devices' }],
    },
    formSchema: () => ({ sections: [] }),
    initialBody: (name): BlocksConnectionBody => ({ name }),
    configured: () => true,
    // Nothing of the integration is read from the record.
    onChanged: () => undefined,
  })
}
