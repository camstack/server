/**
 * The wire shapes of `apiCatalog.*` — the API explorer's data (planning#595).
 *
 * One entry per tRPC method the hub serves, capability and core routes alike,
 * read off the live router by the hub (never a hand-written list).
 */
import { z } from 'zod'

export const ApiProcedureKindSchema = z.enum(['query', 'mutation', 'subscription'])
export type ApiProcedureKind = z.infer<typeof ApiProcedureKindSchema>

/** The gate a method runs behind. */
export const ApiProcedureTierSchema = z.enum(['public', 'protected', 'admin'])
export type ApiProcedureTier = z.infer<typeof ApiProcedureTierSchema>

/** The token scope a capability route is matched against (its `METHOD_ACCESS_MAP` row). */
export const ApiCatalogScopeSchema = z.object({
  capName: z.string(),
  capScope: z.enum(['device', 'system']),
  access: z.enum(['view', 'create', 'delete']),
  role: z.string(),
})
export type ApiCatalogScope = z.infer<typeof ApiCatalogScopeSchema>

export const ApiCatalogEntrySchema = z.object({
  /** `<router>.<method>` — the tRPC path. */
  path: z.string(),
  router: z.string(),
  method: z.string(),
  kind: ApiProcedureKindSchema,
  tier: ApiProcedureTierSchema,
  source: z.enum(['capability', 'core']),
  /** `null` on a core route: it needs authentication only (plus admin where its tier says so). */
  scope: ApiCatalogScopeSchema.nullable(),
  hasInput: z.boolean(),
})
export type ApiCatalogEntry = z.infer<typeof ApiCatalogEntrySchema>

export const ApiCatalogMethodSchema = ApiCatalogEntrySchema.extend({
  /**
   * May the CALLER call it — decided at path level, without an input: a
   * device-scoped grant still checks the device on the real call.
   */
  callable: z.boolean(),
})
export type ApiCatalogMethod = z.infer<typeof ApiCatalogMethodSchema>

export const ApiCatalogListOutputSchema = z.object({ methods: z.array(ApiCatalogMethodSchema) })
export type ApiCatalogListOutput = z.infer<typeof ApiCatalogListOutputSchema>

/** A JSON Schema document, as the explorer receives it. */
export const JsonSchemaDocumentSchema = z.record(z.string(), z.unknown())
export type JsonSchemaDocument = z.infer<typeof JsonSchemaDocumentSchema>

export const ApiCatalogInputSchemaOutputSchema = z.object({
  path: z.string(),
  hasInput: z.boolean(),
  /** The INPUT JSON schema (what the caller sends); `null` without input or when it could not be produced. */
  schema: JsonSchemaDocumentSchema.nullable(),
  /** Why no schema could be produced (a non-Zod parser, an unrepresentable type). */
  error: z.string().nullable(),
})
export type ApiCatalogInputSchemaOutput = z.infer<typeof ApiCatalogInputSchemaOutputSchema>
