/**
 * Which detection sensors a camera gets (R1, D772): the classes its pipeline
 * can emit, from `pipelineAnalytics.listEventKinds` — the same answer the
 * viewer's timeline lanes use, so the Alexa sensors and the CamStack lanes
 * never disagree about what a camera detects.
 *
 * A class that DISAPPEARS from that answer is removed only when it has been
 * missing for {@link CLASS_REMOVAL_CONFIRM_MS} across reads. The answer is
 * composed from several reads and an orchestrator that cannot be reached
 * yields "no ML classes" rather than an error, and removing a class deletes the
 * user's Alexa sensor and every routine built on it (D49: a read that
 * contradicts the mirror in the direction that destroys work needs a second
 * read to agree). A class that APPEARS is added at once. A read that throws
 * changes nothing.
 */
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { DETECTION_SENSOR_CLASSES, type DetectionSensorClass } from '../handlers/endpoint-id.js'
import { detectionClassOf } from './detection-tracker.js'

export const CLASS_REMOVAL_CONFIRM_MS = 15 * 60_000

/** The fields of an event-kind descriptor this source reads. */
export interface EventKindLike {
  readonly kind: string
  readonly level: string
  readonly category: string
}

/** What is persisted per camera. */
export interface StoredDetectionClasses {
  readonly classes: readonly DetectionSensorClass[]
  /** class → ms epoch it was first seen missing. */
  readonly missingSince?: Readonly<Partial<Record<DetectionSensorClass, number>>>
}

export type StoredDetectionClassMap = Readonly<Record<number, StoredDetectionClasses>>

export interface DetectionClassSourceDeps {
  readonly readEventKinds: (deviceId: number) => Promise<readonly EventKindLike[]>
  readonly getStored: () => StoredDetectionClassMap
  readonly setStored: (next: StoredDetectionClassMap) => Promise<void>
  readonly logger: IScopedLogger
  readonly now?: () => number
}

/** The detection classes an event-kind answer offers. */
export function detectionClassesOfKinds(
  kinds: readonly EventKindLike[],
): readonly DetectionSensorClass[] {
  const out = new Set<DetectionSensorClass>()
  for (const k of kinds) {
    if (k.level !== 'macro') continue
    if (k.category !== 'detection' && k.category !== 'package') continue
    const cls = detectionClassOf(k.kind)
    if (cls !== null) out.add(cls)
  }
  return DETECTION_SENSOR_CLASSES.filter((c) => out.has(c))
}

function sameClasses(a: StoredDetectionClasses | undefined, b: StoredDetectionClasses): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b)
}

export class DetectionClassSource {
  /** Serializes the persisted map's read-modify-write: builds run four
   *  cameras at once, and two writes computed off one snapshot would erase
   *  each other's camera. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: DetectionClassSourceDeps) {}

  private persist(deviceId: number, next: StoredDetectionClasses): Promise<void> {
    const write = this.writeChain.then(() =>
      this.deps.setStored({ ...this.deps.getStored(), [deviceId]: next }),
    )
    this.writeChain = write.catch(() => undefined)
    return write
  }

  async classesFor(deviceId: number): Promise<readonly DetectionSensorClass[]> {
    const prev = this.deps.getStored()[deviceId]
    let read: readonly DetectionSensorClass[]
    try {
      read = detectionClassesOfKinds(await this.deps.readEventKinds(deviceId))
    } catch (err) {
      this.deps.logger.debug(
        'alexa detection sensors: class read failed — keeping the last answer',
        {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        },
      )
      return prev?.classes ?? []
    }
    const now = this.deps.now?.() ?? Date.now()
    const missingSince: Partial<Record<DetectionSensorClass, number>> = {}
    const keep = new Set<DetectionSensorClass>(read)
    const removed: DetectionSensorClass[] = []
    for (const cls of prev?.classes ?? []) {
      if (keep.has(cls)) continue
      const since = prev?.missingSince?.[cls] ?? now
      if (now - since >= CLASS_REMOVAL_CONFIRM_MS) {
        removed.push(cls)
        continue
      }
      keep.add(cls)
      missingSince[cls] = since
    }
    const classes = DETECTION_SENSOR_CLASSES.filter((c) => keep.has(c))
    const next: StoredDetectionClasses =
      Object.keys(missingSince).length > 0 ? { classes, missingSince } : { classes }
    if (!sameClasses(prev, next)) {
      await this.persist(deviceId, next)
      if (removed.length > 0 || classes.some((c) => !(prev?.classes ?? []).includes(c))) {
        this.deps.logger.info("alexa detection sensors: the camera's detection classes changed", {
          tags: { deviceId },
          meta: { classes, removed },
        })
      }
    }
    return classes
  }
}
