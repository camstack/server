import { z } from 'zod'
import {
  method,
  optionalMethod,
  type CapabilityDefinition,
  type InferProvider,
} from './capability-definition.js'

const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])

const LogEntrySchema = z.object({
  timestamp: z.date(),
  level: LogLevelSchema,
  scope: z.array(z.string()),
  message: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
  tags: z.record(z.string(), z.string()).optional(),
})

/**
 * A history READ against one destination (D898).
 *
 * Every filter is applied by the PROVIDER, before the limit — a filter the
 * browser applied after the limit is what made a rare device's lines
 * unreachable behind a busy one's. `before` / `after` are cursors the provider
 * minted (opaque to everyone else): a file position for the rotated files, a
 * nanosecond timestamp for Loki.
 *
 * A read is BOUNDED by `budgetMs`: a filter that matches nothing on a 30-day
 * store answers `done: false` with the cursor it reached and the bytes it
 * scanned, and the caller decides whether to go on. That is what makes a long
 * scan show progress and stop when asked — `cancelRead` ends the slice in
 * flight, and not asking for the next slice ends the scan.
 */
const LogReadQuerySchema = z.object({
  /** Correlates `cancelRead`. Caller-chosen, unique per in-flight read. */
  requestId: z.string().min(1).max(64).optional(),
  /** The device the line is about (`tags.deviceId`, numeric). */
  deviceId: z.number().int().optional(),
  /**
   * The emitting addon — bare manifest id; `@<version>` / `::<sub>` suffixes
   * match. Not `addonId`: a cap router reads that name as "which provider".
   */
  fromAddonId: z.string().min(1).max(200).optional(),
  /**
   * The emitting node: matches the agent that emitted the line, the node
   * itself, or a worker under it (`<agent>/<runner>`) — the `agentId`
   * semantics of `matchesLogTags`. Not `nodeId`: a cap router reads that
   * name as "which node's provider".
   */
  fromNodeId: z.string().min(1).max(200).optional(),
  /** Any other tag, exact match (AND). */
  tags: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  /** Severity FLOOR: this level and above. */
  level: LogLevelSchema.optional(),
  /** Case-insensitive substring over message, scope, tag values and meta values. */
  text: z.string().min(1).max(200).optional(),
  /** Epoch ms, inclusive. */
  since: z.number().optional(),
  /** Epoch ms, inclusive. */
  until: z.number().optional(),
  /** Older than this cursor (exclusive). Absent with `after` absent ⇒ from the newest. */
  before: z.string().min(1).max(1024).optional(),
  /** Newer than this cursor (exclusive). */
  after: z.string().min(1).max(1024).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  /** Wall-clock bound of this slice. The provider caps it. */
  budgetMs: z.number().int().min(50).max(10_000).optional(),
})

const LogReadEntrySchema = z.object({
  /** `<bootId>.<seq>` minted by the emitting LogManager — the dedupe key. */
  id: z.string().optional(),
  /** Epoch ms. */
  timestamp: z.number(),
  level: LogLevelSchema,
  scope: z.string().optional(),
  message: z.string(),
  tags: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})

const LogReadResultSchema = z.object({
  /** Newest first. */
  entries: z.array(LogReadEntrySchema),
  /** Pass as `before` for the next older page; null when nothing older exists. */
  nextBefore: z.string().nullable(),
  /** Pass as `after` to read what arrived since; null when unknown. */
  nextAfter: z.string().nullable(),
  /** Bytes this slice read (files) or received (remote). Progress, not a promise. */
  scannedBytes: z.number().int().nonnegative(),
  /**
   * True when the scan in this direction reached the end of the store.
   * False with fewer than `limit` entries means the budget ran out first —
   * call again with `nextBefore` to go on.
   */
  done: z.boolean(),
  /** True when `cancelRead` ended this slice early. */
  cancelled: z.boolean().optional(),
})

const LogReadCapabilitiesSchema = z.object({
  /** False ⇒ this destination only ships lines (console, forwarder, an unconfigured Loki). */
  readable: z.boolean(),
  /** Why not, when `readable` is false — rendered next to the source. */
  reason: z.string().nullable(),
  /** Filters the provider applies itself. A false one is applied by nobody. */
  filters: z.object({
    deviceId: z.boolean(),
    addonId: z.boolean(),
    nodeId: z.boolean(),
    tags: z.boolean(),
    level: z.boolean(),
    text: z.boolean(),
    timeRange: z.boolean(),
  }),
  /** How far back the store reaches, when the provider knows (days). */
  retentionDays: z.number().nullable(),
})

export const logDestinationCapability = {
  name: 'log-destination',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    write: method(LogEntrySchema, z.void(), { kind: 'mutation' }),
    /** Absent ⇒ the destination cannot read back (same as `readable: false`). */
    describeRead: optionalMethod(z.void(), LogReadCapabilitiesSchema, { auth: 'admin' }),
    read: optionalMethod(LogReadQuerySchema, LogReadResultSchema, { auth: 'admin' }),
    cancelRead: optionalMethod(
      z.object({ requestId: z.string().min(1).max(64) }),
      z.object({ cancelled: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/system` `buildCapRouters`. */
  mount: { kind: 'skip' },
} as const satisfies CapabilityDefinition

export type ILogDestinationProvider = InferProvider<typeof logDestinationCapability>
export type LogReadQuery = z.infer<typeof LogReadQuerySchema>
export type LogReadEntry = z.infer<typeof LogReadEntrySchema>
export type LogReadResult = z.infer<typeof LogReadResultSchema>
export type LogReadCapabilities = z.infer<typeof LogReadCapabilitiesSchema>

export {
  LogEntrySchema,
  LogLevelSchema,
  LogReadQuerySchema,
  LogReadEntrySchema,
  LogReadResultSchema,
  LogReadCapabilitiesSchema,
}
