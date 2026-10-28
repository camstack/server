import { z } from 'zod'

/** Maximum number of mark/space entries one pulse train may carry. */
export const IR_TIMINGS_MAX = 1024

/**
 * A pulse train in signed microseconds: mark (+) first, then space (-), strictly
 * alternating, no zeros, 2..1024 entries.
 */
export const IrTimingsSchema = z
  .array(z.number().int())
  .min(2)
  .max(IR_TIMINGS_MAX)
  .superRefine((timings, ctx) => {
    timings.forEach((value, index) => {
      const expectMark = index % 2 === 0
      if (value === 0 || value > 0 !== expectMark) {
        ctx.addIssue({
          code: 'custom',
          message: `timing ${index} must be a non-zero ${expectMark ? 'mark (positive)' : 'space (negative)'}`,
          path: [index],
        })
      }
    })
  })
export type IrTimings = z.infer<typeof IrTimingsSchema>

/** Per-command transmit options. Every key is optional; a transmitter applies what it can. */
export const TransmitSettingsSchema = z.object({
  carrierHz: z.number().int().positive().optional(),
  dutyCyclePercent: z.number().int().min(1).max(100).optional(),
  repeat: z.number().int().min(0).max(20).optional(),
  repeatDelayMs: z.number().int().min(0).optional(),
})
export type TransmitSettings = z.infer<typeof TransmitSettingsSchema>
