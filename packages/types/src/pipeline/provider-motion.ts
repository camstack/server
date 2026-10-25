/**
 * A camera provider's RAW onboard motion push (D673). Providers emit THIS —
 * never `MotionOnMotionChanged` — and the orchestrator's camera-sensors bridge
 * is the one emitter of the camera's EFFECTIVE onboard motion (a pass-through
 * for a camera with no attached sensor). Guarded by
 * `scripts/check-onboard-motion-emitters.ts`.
 */
import type { z } from 'zod'
import { MotionOnMotionChangedDataSchema } from '../capabilities/motion.cap.js'
import { EventCategory } from '../enums/event-category.js'
import { createEvent, type EventSource, type TypedSystemEvent } from '../interfaces/event-bus.js'

/** The motion event's data without `triggeredBy`: only the bridge names a trigger. */
export const ProviderMotionDataSchema = MotionOnMotionChangedDataSchema.omit({ triggeredBy: true })
export type ProviderMotionData = z.infer<typeof ProviderMotionDataSchema>

export function providerMotionEvent(
  source: EventSource,
  data: ProviderMotionData,
): TypedSystemEvent<EventCategory.ProviderMotion> {
  return createEvent(EventCategory.ProviderMotion, source, data)
}
