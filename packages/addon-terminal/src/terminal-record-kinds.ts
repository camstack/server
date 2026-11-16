/**
 * A Terminal instance as a record (D1013): one `terminals` row per instance, owned by `terminal`,
 * listed and edited through `integration-instances` on the Terminal page.
 *
 * The record id IS the instance id the old settings list carried. A Terminal declares no camera
 * of its own: a Terminal camera is a core block naming the record id (planning#580).
 */
import { type DefinedRecordKind, defineEntryKind } from '@camstack/types'
import { z } from 'zod'

export type TerminalBody = {
  readonly name: string
  readonly nodeId: string
  readonly profileId: string
  readonly profileLabel: string
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly environment: readonly string[]
  readonly profileSettings: Record<string, unknown>
  /** The instance's own switch (D1013). Absent means on. */
  readonly enabled?: boolean | undefined
}

/** The schema is checked against the interface by its annotation: a drifted field fails the typecheck. */
export const TerminalBodySchema: z.ZodType<TerminalBody> = z.object({
  name: z.string().min(1).max(160),
  nodeId: z.string().max(256),
  profileId: z.string().max(64),
  profileLabel: z.string().max(120),
  executable: z.string().max(1024),
  args: z.array(z.string().max(2048)).max(64),
  cwd: z.string().max(1024),
  environment: z.array(z.string().max(4096)).max(64),
  profileSettings: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
})

export const TERMINAL_INSTANCES_KIND_NAME = 'terminals'

export const terminalInstancesKind: DefinedRecordKind<z.ZodType<TerminalBody>> = defineEntryKind(
  TERMINAL_INSTANCES_KIND_NAME,
  {
    title: 'Terminals',
    nameField: 'name',
    schema: TerminalBodySchema,
    writeTrigger: 'an operator adds, edits, switches or deletes a Terminal on the Terminal page',
  },
)

/** The body a new Terminal starts with: no node and no profile yet, so nothing can run it. */
export function initialTerminalBody(name: string): TerminalBody {
  return {
    name,
    nodeId: '',
    profileId: '',
    profileLabel: '',
    executable: '',
    args: [],
    cwd: '',
    environment: [],
    profileSettings: {},
  }
}
