/**
 * The second render pass of a notification's authored text (D1021): device
 * value templates (`{{ states('sensor.x') }}`), rendered on the hub by the ONE
 * renderer (`device-manager.renderDeviceTemplates`) — this package keeps no
 * copy of it and no copy of the device state.
 *
 * It runs on the AUTHORED template, before the D629 `{{var}}` pass, with the
 * `{{var}}` placeholders set aside, so a variable's value (a camera name, a
 * label a detection brought) is data and never template source. An unknown
 * device value prints `—` in the text and its reason is returned as a note for
 * the delivery log; a refused render returns `refused`, and the caller falls
 * back to the catalog sentence rather than losing the notification.
 */
import type { DeviceTemplateRender } from '@camstack/types'

/** The hub's renderer, as a dependency. */
export type NcRenderDeviceTemplates = (
  templates: readonly string[],
) => Promise<readonly DeviceTemplateRender[]>

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g
const SLOT_OPEN = ''
const SLOT_CLOSE = ''
const SLOT = new RegExp(`${SLOT_OPEN}(\\d+)${SLOT_CLOSE}`, 'g')
const MARKUP = /\{\{|\{%/

export interface NcDevicePassResult {
  /** The template to hand the D629 pass; the input itself when it carried no device template. */
  readonly template: string | undefined
  /** `ref: reason` per value that printed `—`. */
  readonly notes: readonly string[]
  /** Set when the render was refused; the template is then `undefined`. */
  readonly refused?: string
}

/** True when the text carries template markup beyond `{{var}}` placeholders. */
export function carriesDeviceTemplateMarkup(text: string | undefined): boolean {
  return text !== undefined && MARKUP.test(text.replace(PLACEHOLDER, ''))
}

/** Renders every authored text that carries a device template, in one call. */
export async function renderAuthoredDeviceTemplates(
  texts: readonly (string | undefined)[],
  render: NcRenderDeviceTemplates | undefined,
): Promise<readonly NcDevicePassResult[]> {
  const held: string[][] = texts.map(() => [])
  const sources: string[] = []
  const slotOf: number[] = []
  texts.forEach((text, i) => {
    if (!carriesDeviceTemplateMarkup(text) || text === undefined) return
    const bag = held[i] ?? []
    sources.push(
      text.replace(PLACEHOLDER, (whole) => {
        bag.push(whole)
        return `${SLOT_OPEN}${bag.length - 1}${SLOT_CLOSE}`
      }),
    )
    slotOf.push(i)
  })
  if (sources.length === 0) return texts.map((template) => ({ template, notes: [] }))
  let answers: readonly DeviceTemplateRender[] = []
  let failure: string | undefined
  if (render === undefined) failure = 'unavailable: no device template renderer on this node'
  else {
    try {
      answers = await render(sources)
    } catch (err: unknown) {
      failure = `unavailable: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return texts.map((template, i) => {
    const at = slotOf.indexOf(i)
    if (at < 0) return { template, notes: [] }
    if (failure !== undefined) return { template: undefined, notes: [], refused: failure }
    const answer = answers[at]
    if (answer === undefined) return { template: undefined, notes: [], refused: 'unavailable: no answer' }
    if (!answer.ok) {
      return { template: undefined, notes: [], refused: `${answer.refusal.reason}: ${answer.refusal.message}` }
    }
    const bag = held[i] ?? []
    return {
      template: answer.text.replace(SLOT, (_m, n: string) => bag[Number(n)] ?? ''),
      notes: answer.trace.map((entry) => `${entry.ref}: ${entry.reason}`),
    }
  })
}
