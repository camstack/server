/**
 * Reads the assisted-setup tools and `debug_report` share about cameras: the
 * camera list (with the disabled flag) and the orchestrator's per-camera
 * status, trimmed to the fields those tools use. Every schema is loose (a newer
 * hub may add fields); a failed read is a reason, never an empty answer.
 */
import type { HubClient } from '@camstack/develop'
import { z } from 'zod'
import { readQuery, type Read } from './ops-hub.js'

const CameraRowSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  disabled: z.boolean().optional(),
})

export interface CameraRow {
  readonly id: number
  readonly name: string
  readonly disabled: boolean
}

export async function readCameraRows(client: HubClient): Promise<Read<readonly CameraRow[]>> {
  const read = await readQuery(
    client,
    'deviceManager.listAll',
    { projection: 'slim', isCamera: true },
    z.array(CameraRowSchema),
  )
  if (!read.ok) return read
  return {
    ok: true,
    value: read.value.map((d) => ({ id: d.id, name: d.name, disabled: d.disabled === true })),
  }
}

const StatusSchema = z.looseObject({
  deviceId: z.number(),
  assignment: z
    .looseObject({
      detectionNodeId: z.string().nullable(),
      sourceNodeId: z.string().nullable(),
      pinned: z.looseObject({ detection: z.boolean() }).optional(),
    })
    .optional(),
  broker: z
    .looseObject({
      profiles: z.array(
        z.looseObject({
          profile: z.string(),
          status: z.string(),
          codec: z.string(),
          width: z.number(),
          height: z.number(),
          subscribers: z.number(),
          inFps: z.number().nullable(),
        }),
      ),
      webrtcSessions: z.number(),
    })
    .nullable()
    .optional(),
  detection: z
    .looseObject({
      nodeId: z.string(),
      engine: z.looseObject({ backend: z.string(), device: z.string() }),
      phase: z.string(),
      configuredFps: z.number(),
      actualFps: z.number(),
      avgInferenceMs: z.number(),
    })
    .nullable()
    .optional(),
  recording: z
    .looseObject({ mode: z.string(), active: z.boolean(), storageBytes: z.number() })
    .nullable()
    .optional(),
  switchedOff: z.array(z.string()).optional(),
  degraded: z.array(z.unknown()).optional(),
})

export type CameraStatusSlice = z.infer<typeof StatusSchema>

/** Every camera's status, by device id. */
export async function readCameraStatuses(
  client: HubClient,
): Promise<Read<ReadonlyMap<number, CameraStatusSlice>>> {
  const read = await readQuery(
    client,
    'pipelineOrchestrator.getCameraStatuses',
    {},
    z.array(StatusSchema),
  )
  if (!read.ok) return read
  return { ok: true, value: new Map(read.value.map((s) => [s.deviceId, s])) }
}
