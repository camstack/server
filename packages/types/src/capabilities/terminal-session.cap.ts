import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/** Profile-exported FormBuilder schema. Shape is ConfigUISchema at the UI. */
const ProfileSettingsSchemaBridge = z.unknown().nullable()

const ProfileSettingsBagSchema = z.record(z.string(), z.unknown())

/**
 * A live terminal session hosted by the provider addon. Output and input do
 * NOT flow through the capability — they use the addon data plane
 * (`GET /addon/terminal/<id>/out` SSE, `POST /addon/terminal/<id>/in`) because
 * terminal output must be ordered and lossless. The event bus is telemetry and
 * may drop chunks ([D8]), and a dropped chunk desynchronises the vt parser
 * permanently until a full repaint. The capability owns only lifecycle.
 */
const TerminalSessionInfoSchema = z.object({
  /** Opaque session id minted by the provider on `openSession`. */
  sessionId: z.string(),
  /** The pre-declared profile this session runs (never a free-form command). */
  profileId: z.string(),
  /** Human-readable profile label for the UI session list. */
  label: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  /** ms-epoch the session's pty was spawned. */
  startedAt: z.number(),
})

/**
 * A profile the operator may open — a pre-declared, allowlisted program
 * (`monitor` → `btm`). The capability accepts only these ids; a free-form
 * command string would be remote code execution as the server's user, so it is
 * deliberately not part of the contract.
 */
const TerminalProfileInfoSchema = z.object({
  profileId: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** Spawn defaults the instance form copies on create. */
  executable: z.string().optional(),
  args: z.array(z.string()).readonly().optional(),
  cwd: z.string().optional(),
  environment: z.array(z.string()).readonly().optional(),
  /** ConfigUISchema for instance knobs, or null when the profile has none. */
  settingsSchema: ProfileSettingsSchemaBridge.optional(),
})

/**
 * A durable operator-created Terminal instance. Profiles are templates; only
 * an instance declares a camera.
 */
const TerminalInstanceInfoSchema = z.object({
  instanceId: z.string(),
  cameraStableId: z.string(),
  nodeId: z.string(),
  /**
   * False while the node the instance is bound to is not in the cluster
   * topology (forgotten, renamed, re-paired). The instance is kept; the
   * operator re-points it with `updateInstance({ targetNodeId })`.
   */
  nodeInCluster: z.boolean(),
  profileId: z.string(),
  profileLabel: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  executable: z.string(),
  args: z.array(z.string()).readonly(),
  cwd: z.string(),
  environment: z.array(z.string()).readonly(),
  profileSettings: ProfileSettingsBagSchema,
})

const TerminalLegacyCameraSchema = z.object({
  stableId: z.string(),
  nodeId: z.string(),
  profileId: z.string(),
  profileLabel: z.string(),
  name: z.string(),
  /** Only legacy monitor cameras can retain their historic stable identity. */
  adoptable: z.boolean(),
})

const TerminalOutputEventSchema = z.discriminatedUnion('kind', [
  z.object({ seq: z.number().int().positive(), kind: z.literal('data'), data: z.string() }),
  z.object({
    seq: z.number().int().positive(),
    kind: z.literal('exit'),
    exitCode: z.number().int(),
    signal: z.number().int().optional(),
  }),
])

const TerminalOutputBatchSchema = z.object({
  cursor: z.number().int().nonnegative(),
  reset: z.boolean(),
  snapshot: z.string().optional(),
  events: z.array(TerminalOutputEventSchema).readonly(),
})

/**
 * terminal-session — singleton system capability for interactive TTY sessions.
 *
 * Owns both live PTY lifecycle and durable Terminal instance management.
 * Profiles are allowlisted templates; an explicit instance is the only path
 * that declares a camera.
 */
export const terminalSessionCapability = {
  name: 'terminal-session',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /** Pre-declared profiles the operator may open. */
    listProfiles: method(z.void(), z.array(TerminalProfileInfoSchema).readonly(), {
      auth: 'admin',
    }),
    /** Explicit durable Terminal instances, managed centrally on the hub. */
    listInstances: method(z.void(), z.array(TerminalInstanceInfoSchema).readonly(), {
      auth: 'admin',
    }),
    createInstance: method(
      z.object({
        targetNodeId: z.string().min(1),
        profileId: z.string().min(1),
        name: z.string().trim().min(1).max(160).optional(),
        executable: z.string().max(1024).optional(),
        args: z.array(z.string().max(2048)).max(64).optional(),
        cwd: z.string().max(1024).optional(),
        environment: z.array(z.string().max(4096)).max(64).optional(),
        profileSettings: ProfileSettingsBagSchema.optional(),
      }),
      TerminalInstanceInfoSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    updateInstance: method(
      z.object({
        instanceId: z.string().min(1),
        /** Re-point the instance to another node; the profile must exist there. */
        targetNodeId: z.string().min(1).max(256).optional(),
        name: z.string().trim().min(1).max(160).optional(),
        executable: z.string().max(1024).optional(),
        args: z.array(z.string().max(2048)).max(64).optional(),
        cwd: z.string().max(1024).optional(),
        environment: z.array(z.string().max(4096)).max(64).optional(),
        profileSettings: ProfileSettingsBagSchema.optional(),
      }),
      TerminalInstanceInfoSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    deleteInstance: method(z.object({ instanceId: z.string().min(1) }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    setInstanceEnabled: method(
      z.object({ instanceId: z.string().min(1), enabled: z.boolean() }),
      TerminalInstanceInfoSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Existing automatic cameras are shown for explicit migration only. */
    listLegacyCameras: method(z.void(), z.array(TerminalLegacyCameraSchema).readonly(), {
      auth: 'admin',
    }),
    /** Explicitly adopt one legacy monitor camera, retaining its stable id. */
    adoptLegacyMonitor: method(
      z.object({ stableId: z.string().min(1), name: z.string().trim().min(1).max(160).optional() }),
      TerminalInstanceInfoSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Live sessions currently hosted by the provider. */
    listSessions: method(z.void(), z.array(TerminalSessionInfoSchema).readonly(), {
      auth: 'admin',
    }),
    /**
     * Spawn a pty for an allowlisted profile at the given grid size and return
     * its session id. Output/input then flow over the data plane by that id.
     */
    openSession: method(
      z.object({
        profileId: z.string(),
        cols: z.number().int().positive(),
        rows: z.number().int().positive(),
        executable: z.string().max(1024).optional(),
        args: z.array(z.string().max(2048)).max(64).optional(),
        cwd: z.string().max(1024).optional(),
        environment: z.array(z.string().max(4096)).max(64).optional(),
      }),
      TerminalSessionInfoSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Resize a live session's pty (reflows the running program). */
    resize: method(
      z.object({
        sessionId: z.string(),
        cols: z.number().int().positive(),
        rows: z.number().int().positive(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Pull ordered output after a cursor. This capability transport is what
     * makes remote-agent terminals possible; `reset + snapshot` repairs a
     * caller that fell behind the bounded replay window.
     */
    pullOutput: method(
      z.object({
        sessionId: z.string(),
        afterSeq: z.number().int().nonnegative(),
        waitMs: z.number().int().min(0).max(2_000).default(0),
        /**
         * Wait when a just-opened session has no output yet. Kept opt-in so a
         * browser's initial repaint remains immediate; the camera snapshot
         * relay uses it to avoid encoding a blank startup frame.
         */
        waitForOutput: z.boolean().optional(),
      }),
      TerminalOutputBatchSchema,
      { kind: 'mutation', auth: 'admin', timeoutMs: 15_000 },
    ),
    /** Write terminal input through the node-routable capability plane. */
    writeInput: method(
      z.object({
        sessionId: z.string(),
        data: z.string().max(64 * 1024),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Terminate a live session and release its pty. */
    close: method(z.object({ sessionId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type ITerminalSessionProvider = InferProvider<typeof terminalSessionCapability>

export type TerminalSessionInfo = z.infer<typeof TerminalSessionInfoSchema>
export type TerminalProfileInfo = z.infer<typeof TerminalProfileInfoSchema>
export type TerminalInstanceInfo = z.infer<typeof TerminalInstanceInfoSchema>
export type TerminalLegacyCamera = z.infer<typeof TerminalLegacyCameraSchema>
export type TerminalOutputEvent = z.infer<typeof TerminalOutputEventSchema>
export type TerminalOutputBatch = z.infer<typeof TerminalOutputBatchSchema>

export {
  TerminalInstanceInfoSchema,
  TerminalLegacyCameraSchema,
  TerminalOutputBatchSchema,
  TerminalOutputEventSchema,
  TerminalProfileInfoSchema,
  TerminalSessionInfoSchema,
}
