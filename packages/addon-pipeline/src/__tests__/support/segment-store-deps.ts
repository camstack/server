import { vi } from 'vitest'
import type { SegmentStoreDeps } from '../../recorder/segment-store.js'
import type { RecordingIndex } from '../../recorder/recording-index.js'

/** SegmentStore deps with no-op filesystem hooks for recorder specs. */
export function makeSegmentStoreDeps(
  index: RecordingIndex,
  patch: Partial<Omit<SegmentStoreDeps, 'index'>> = {},
): SegmentStoreDeps {
  return {
    index,
    list: patch.list ?? vi.fn(async () => []),
    deletePath: patch.deletePath ?? vi.fn(async () => {}),
    statBytes: patch.statBytes ?? vi.fn(async () => 0),
    moveFile: patch.moveFile ?? vi.fn(async () => {}),
    removeDir: patch.removeDir ?? vi.fn(async () => {}),
    logger: patch.logger ?? { warn: vi.fn(), info: vi.fn() },
  }
}
