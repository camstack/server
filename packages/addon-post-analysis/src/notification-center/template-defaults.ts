/**
 * The default texts a rule is delivered with when the operator wrote none,
 * served through `getTemplateCatalog` so an editor can pre-fill them.
 *
 * Read from the live text catalog (`texts.raw`): the SAME key the dispatcher
 * falls back to (`appliance.finished.*`), so what an editor shows is what a
 * template-less rule sends — language and operator overrides included.
 */
import type { NcTemplateDefault } from '@camstack/types'
import type { NcTextCatalog } from './text-catalog.js'

export function servedTemplateDefaults(texts: NcTextCatalog): NcTemplateDefault[] {
  return [
    {
      id: 'appliance-cycle',
      kind: 'sensor',
      title: texts.raw('appliance.finished.title') ?? '',
      body: texts.raw('appliance.finished.body') ?? '',
    },
  ]
}
