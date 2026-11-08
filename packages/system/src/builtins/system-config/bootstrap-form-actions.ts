/**
 * System → Authentication / the first-login server name — the bootstrap form.
 *
 * `system-config` owns nine keys that stay bootstrap `ConfigManager` values
 * (`server.name`, `server.port|host|dataPath`, `auth.tokenExpiry|accessTokenExpiry|
 * trustedProxies|trustedNetworks|corsOrigins`). They are NOT addon settings: no
 * capability declares them, so the scoped settings API (`getScopedSettings` /
 * `updateScopedSettings`) is not their carrier. The form is served by this
 * action pair instead (D986 §7).
 *
 * Reading is open to any signed-in caller, as the scoped read is; a save is
 * admin-only, as `addonSettings.updateScopedSettings` is.
 */
import { z } from 'zod'
import {
  customAction,
  defineCustomActions,
  type ConfigUISchemaWithValues,
  type CustomActionsSpec,
} from '@camstack/types'

/** The hydrated form: schema with each field's stored value inline. */
const BootstrapFormSchema = z.custom<ConfigUISchemaWithValues>(
  (value) =>
    typeof value === 'object' && value !== null && Array.isArray(Reflect.get(value, 'sections')),
)

/** Field key → new value. Only the keys the operator changed. */
const BootstrapFormPatchSchema = z.record(z.string(), z.unknown())

/** The save input: the patch of the fields the operator changed. */
export interface BootstrapFormSaveInput {
  readonly patch: Record<string, unknown>
}
export const BootstrapFormSaveInputSchema: z.ZodType<BootstrapFormSaveInput> = z.object({
  patch: BootstrapFormPatchSchema,
})

export const bootstrapFormActions: CustomActionsSpec = defineCustomActions({
  /** The hydrated bootstrap form. A section that cannot be read fails the call. */
  getBootstrapForm: customAction(z.object({}), BootstrapFormSchema, {
    kind: 'query',
  }),
  /** Validate and write the patch; a refused patch writes nothing. */
  saveBootstrapForm: customAction(
    BootstrapFormSaveInputSchema,
    z.object({ success: z.literal(true) }),
    { kind: 'mutation', auth: 'admin' },
  ),
})
