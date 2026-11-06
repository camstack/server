/**
 * The link primitive's declaration half (D1013 rule 5): what a link field names and how a kind
 * records it. Split from `instance-link.ts` so `RecordIntegrationInstances` can read the links of
 * its kind without importing the builders that import it.
 */
import { z } from 'zod'
import type { DefinedRecordKind } from '../records/record-kind.js'

/** What a link points at: the function cap of the target instance and, optionally, its kind. */
export interface LinkTarget {
  readonly cap: string
  readonly kind?: string
}

/** One link a record kind declares: the body field that holds the target instance id. */
export interface KindLink {
  readonly field: string
  readonly to: LinkTarget
}

/** The body field of a link: the id of the instance it names; the target rides in the field meta. */
export function linkField(target: LinkTarget): z.ZodString {
  return z.string().meta({ link: target })
}

function linkTargetOf(meta: unknown): LinkTarget | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const link: unknown = Reflect.get(meta, 'link')
  const parsed = LinkTargetSchema.safeParse(link)
  return parsed.success ? parsed.data : undefined
}

const LinkTargetSchema = z.object({ cap: z.string().min(1), kind: z.string().min(1).optional() })

/** The links a kind declares, read from the meta of its body fields. */
export function linksOfKind(kind: DefinedRecordKind<z.ZodType>): readonly KindLink[] {
  const schema = kind.schema
  if (!(schema instanceof z.ZodObject)) return []
  const links: KindLink[] = []
  for (const [field, fieldSchema] of Object.entries(schema.shape)) {
    const to = linkTargetOf(z.globalRegistry.get(fieldSchema))
    if (to !== undefined) links.push({ field, to })
  }
  return links
}
