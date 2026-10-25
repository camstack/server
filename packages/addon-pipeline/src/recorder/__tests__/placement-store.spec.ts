/**
 * The recorder's OWN durable placement state (`recordingPlacement`).
 *
 * It lives here and not on `RecordingConfigSchema` deliberately: that schema is
 * strict, lives in `@camstack/types`, and every field added to it needs a
 * framework train before the recorder can read it. Placement is recorder-owned
 * bookkeeping — a per-(camera, profile) location assignment plus the volume ids
 * the mount probe remembers — so it belongs in the recorder's own addon-store
 * blob, exactly like `recordingConfigs` and `recordingOpsLog`.
 *
 * A corrupt blob reads back EMPTY rather than crashing boot; empty means "no
 * assignment yet", which every caller already handles by resolving placement
 * from scratch.
 */
import { createDurableState } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  assignmentKey,
  EMPTY_PLACEMENT,
  RECORDING_PLACEMENT_KEY,
  type RecordingPlacementBlob,
  RecordingPlacementBlobSchema,
  type RecordingPlacementState,
  readPlacementState,
  rememberVolumeId,
  replaceAssignments,
} from '../addon/placement-store.js'

interface FakeState {
  readonly state: RecordingPlacementState
  readonly blob: Record<string, unknown>
}

/** The same DurableState contract `BaseAddon.state()` hands the addon. */
function fakeState(initial: Record<string, unknown> = {}): FakeState {
  const blob: Record<string, unknown> = { ...initial }
  const state = createDurableState<RecordingPlacementBlob>({
    key: RECORDING_PLACEMENT_KEY,
    schema: RecordingPlacementBlobSchema,
    fallback: EMPTY_PLACEMENT,
    read: async () => ({ ...blob }),
    write: async (patch) => {
      Object.assign(blob, patch)
    },
  })
  return { state, blob }
}

describe('placement store', () => {
  it('reads an empty state when nothing is persisted', async () => {
    const { state } = fakeState()
    const read = await readPlacementState(state)
    expect(read.assignments).toEqual({})
    expect(read.volumeIds).toEqual({})
  })

  it('round-trips assignments keyed by (deviceId, profile)', async () => {
    const { state, blob } = fakeState()

    await replaceAssignments(
      state,
      await readPlacementState(state),
      new Map([
        [assignmentKey(101, 'high'), 'recordings:ssd'],
        [assignmentKey(101, 'low'), 'recordingsLow:nas'],
      ]),
    )

    const read = await readPlacementState(state)
    expect(read.assignments).toEqual({
      '101:high': 'recordings:ssd',
      '101:low': 'recordingsLow:nas',
    })
    expect(blob[RECORDING_PLACEMENT_KEY]).toBeDefined()
  })

  it('remembering a volume id preserves the assignments alongside it', async () => {
    const { state } = fakeState()
    await replaceAssignments(
      state,
      await readPlacementState(state),
      new Map([[assignmentKey(101, 'high'), 'recordings:ssd']]),
    )
    await rememberVolumeId(state, 'recordings:ssd', 'vol-a')

    const read = await readPlacementState(state)
    expect(read.assignments['101:high']).toBe('recordings:ssd')
    expect(read.volumeIds['recordings:ssd']).toBe('vol-a')
  })

  it('a corrupt blob reads back EMPTY instead of crashing boot', async () => {
    const { state } = fakeState({ [RECORDING_PLACEMENT_KEY]: { assignments: 'not-an-object' } })
    const read = await readPlacementState(state)
    expect(read.assignments).toEqual({})
    expect(read.volumeIds).toEqual({})
  })

  it('writing assignments never drops remembered volume ids (whole blob round-trips)', async () => {
    const { state } = fakeState()
    await rememberVolumeId(state, 'recordings:ssd', 'vol-a')
    await replaceAssignments(
      state,
      await readPlacementState(state),
      new Map([[assignmentKey(104, 'mid'), 'recordings:ssd']]),
    )

    const read = await readPlacementState(state)
    expect(read.volumeIds['recordings:ssd']).toBe('vol-a')
    expect(read.assignments['104:mid']).toBe('recordings:ssd')
  })
})
