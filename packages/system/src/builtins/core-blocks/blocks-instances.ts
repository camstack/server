/**
 * The Blocks integration as an `integration-instances` provider (epic #440): the fixed builtin
 * `DeclaredDevices` mints for `core-blocks` (`blocks-integration.ts`) has an instance record under
 * its registry id, holding only its name. It is name-only on purpose: the integration's `enabled`
 * switch stays in the registry (a fixed builtin is switched through `setInstanceEnabled`, whose hub
 * half writes that flag, and `integrations.list` never projects it from a record), and there is nothing to configure.
 */
import {
  type DefinedRecordKind,
  defineEntryKind,
  entryBody,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import type { z } from 'zod'

/** Checked against the schema by its annotation: a drifted field fails the typecheck. */
export type BlocksConnectionBody = {
  readonly name: string
  readonly enabled?: boolean | undefined
}

const BlocksConnectionBodySchema: z.ZodType<BlocksConnectionBody> = entryBody({})

export type BlocksConnectionsEntryKind = DefinedRecordKind<z.ZodType<BlocksConnectionBody>>

export const blocksConnectionsEntryKind: BlocksConnectionsEntryKind = defineEntryKind(
  'connections',
  {
    title: 'Blocks integration',
    schema: BlocksConnectionBodySchema,
    writeTrigger: 'the hub declares the Blocks integration on boot',
  },
)

/** Every kind of the Blocks integration record, keyed by its name. */
export type BlocksInstanceRecordKinds = {
  readonly connections: BlocksConnectionsEntryKind
}

export const blocksInstanceRecordKinds: BlocksInstanceRecordKinds = {
  connections: blocksConnectionsEntryKind,
}

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
