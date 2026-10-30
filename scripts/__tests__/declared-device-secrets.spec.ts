/**
 * D783 — the device-config secrets the keychain survey found by NAME only are
 * now declared by their schemas, and `collectZodSecretPaths` (what a runner
 * reports at `registerDevice`) finds them where they actually sit.
 */
import { collectZodSecretPaths } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { amcrestCameraSchema } from '../../packages/addon-provider-amcrest/src/schema.ts'
import { dreameChildSchema } from '../../packages/addon-provider-dreame/src/devices/dreame-child-device.ts'
import { ecowittGatewaySchema } from '../../packages/addon-provider-ecowitt/src/config.ts'
import { hikvisionCameraSchema } from '../../packages/addon-provider-hikvision/src/schema.ts'
import { rademacherConnectionSchema } from '../../packages/addon-provider-rademacher/src/config.ts'
import {
  reolinkCameraSchema,
  reolinkHubSchema,
} from '../../packages/addon-provider-reolink/src/schema.ts'
import { tuyaDeviceConfigSchema } from '../../packages/addon-provider-tuya/src/devices/tuya-base-device.ts'
import { unifiControllerSchema } from '../../packages/addon-provider-unifi/src/config.ts'
import { unraidHubSchema } from '../../packages/addon-provider-unraid/src/config.ts'
import { veluxConnectionSchema } from '../../packages/addon-provider-velux/src/config.ts'
import { vesyncAccountSchema } from '../../packages/addon-provider-vesync/src/config.ts'

const cases: ReadonlyArray<readonly [string, z.ZodType, readonly string[]]> = [
  ['unifi controller', unifiControllerSchema, ['connection.apiKey', 'connection.password']],
  ['vesync account', vesyncAccountSchema, ['connection.password']],
  ['velux integration', veluxConnectionSchema, ['password']],
  ['rademacher integration', rademacherConnectionSchema, ['password']],
  ['ecowitt gateway (union transport)', ecowittGatewaySchema, ['connection.password']],
  ['unraid hub', unraidHubSchema, ['connection.apiKey']],
  ['tuya device', tuyaDeviceConfigSchema, ['localKey']],
  ['dreame child', dreameChildSchema, ['navigationAccessCode']],
  ['reolink camera', reolinkCameraSchema, ['password']],
  ['reolink hub', reolinkHubSchema, ['password']],
  ['hikvision camera', hikvisionCameraSchema, ['password']],
  ['amcrest camera', amcrestCameraSchema, ['password']],
]

describe('declared device-config secrets', () => {
  it.each(cases)('%s declares its credentials', (_name, schema, expected) => {
    const paths = collectZodSecretPaths(schema)
    for (const p of expected) expect(paths).toContain(p)
  })
})
