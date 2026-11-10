/**
 * Vets the device value templates (`{{ alias.field | filter }}`) an agent writes into the
 * text of an automation step before the save is offered. The hub renders them at run time
 * through the one renderer; a template it would refuse is refused here, with its reason,
 * instead of failing silently the first time the automation runs.
 */
import { DeviceTemplateRefusalSchema, collectDeviceTemplates, holdVarSlots } from '@camstack/types'
import type { HubClient } from '@camstack/develop'
import { z } from 'zod'
import { readQuery } from './ops-hub.js'

/** The hub vets at most this many templates per call (`checkDeviceTemplates`). */
const TEMPLATES_PER_CHECK = 64

const CheckAnswerSchema = z.object({
  results: z.array(
    z.discriminatedUnion('ok', [
      z.looseObject({ ok: z.literal(true) }),
      z.looseObject({ ok: z.literal(false), refusal: DeviceTemplateRefusalSchema }),
    ]),
  ),
})

/** Every string in `value` that the run-time renders as a device template. */
export function templateTexts(value: unknown): readonly string[] {
  return collectDeviceTemplates(value)
}

export type TemplateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: string }

/** Asks the hub to vet `texts` (`deviceManager.checkDeviceTemplates`); the first refusal is the problem. */
export async function vetDeviceTemplates(
  client: HubClient,
  texts: readonly string[],
): Promise<TemplateVerdict> {
  if (texts.length === 0) return { ok: true }
  for (let from = 0; from < texts.length; from += TEMPLATES_PER_CHECK) {
    const batch = texts.slice(from, from + TEMPLATES_PER_CHECK)
    const answer = await readQuery(
      client,
      'deviceManager.checkDeviceTemplates',
      { templates: batch.map((text) => holdVarSlots(text, '·')) },
      CheckAnswerSchema,
    )
    if (!answer.ok) {
      return { ok: false, problem: `could not vet the device templates: ${answer.reason}` }
    }
    if (answer.value.results.length !== batch.length) {
      return {
        ok: false,
        problem: `could not vet the device templates: the hub answered ${answer.value.results.length} verdict(s) for ${batch.length} template(s)`,
      }
    }
    for (const [index, result] of answer.value.results.entries()) {
      if (!result.ok) {
        return {
          ok: false,
          problem: `device template ${JSON.stringify(batch[index])} refused (${result.refusal.reason}): ${result.refusal.message}`,
        }
      }
    }
  }
  return { ok: true }
}
