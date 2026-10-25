import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { zodEntriesToConfigUI } from '../zod-to-config-ui.js'
import type { DeviceConfigEntry } from '../zod-to-config-ui.js'
import type {
  ConfigTextField,
  ConfigNumberField,
  ConfigBooleanField,
  ConfigSelectField,
  ConfigPasswordField,
  ConfigFieldBase,
} from '../../interfaces/config-ui.js'

// All fields produced by zodEntriesToConfigUI extend ConfigFieldBase, so we
// cast via this intersection to access common properties without TS complaining
// about ConfigSeparatorField (which has no label/default).
type AnyBaseField = ConfigFieldBase & { type: string }

// Helper: build a single entry
function entry(key: string, schema: z.ZodType, value: unknown = undefined): DeviceConfigEntry {
  return { key, schema, value, description: schema.description }
}

// Helper: get first field from result, cast to AnyBaseField for simple assertions
function firstField(
  entries: readonly DeviceConfigEntry[],
  sectionTitle?: string,
  sectionId?: string,
): AnyBaseField {
  const result = zodEntriesToConfigUI(entries, sectionTitle, sectionId)
  return result.sections[0]!.fields[0]! as AnyBaseField
}

describe('zodEntriesToConfigUI', () => {
  describe('section structure', () => {
    it('wraps fields in a single section with the given title', () => {
      const result = zodEntriesToConfigUI(
        [entry('name', z.string().describe('Device name'), 'cam1')],
        'My Settings',
        'my-section',
      )
      expect(result.sections).toHaveLength(1)
      expect(result.sections[0]!.title).toBe('My Settings')
      expect(result.sections[0]!.id).toBe('my-section')
    })

    it('uses default title and id when not provided', () => {
      const result = zodEntriesToConfigUI([entry('name', z.string())])
      expect(result.sections[0]!.title).toBe('Configuration')
      expect(result.sections[0]!.id).toBe('main')
    })

    it('returns one field per entry', () => {
      const entries: DeviceConfigEntry[] = [
        entry('a', z.string()),
        entry('b', z.number()),
        entry('c', z.boolean()),
      ]
      const result = zodEntriesToConfigUI(entries)
      expect(result.sections[0]!.fields).toHaveLength(3)
    })
  })

  describe('ZodString → text field', () => {
    it('maps ZodString to type "text"', () => {
      const field = firstField([
        entry('host', z.string().describe('Host address'), 'localhost'),
      ]) as ConfigTextField
      expect(field.type).toBe('text')
      expect(field.key).toBe('host')
      expect(field.label).toBe('Host address')
    })

    it('humanizes key when no description is provided', () => {
      const field = firstField([entry('hostAddress', z.string())])
      expect(field.label).toBe('Host Address')
    })
  })

  describe('ZodString → password field', () => {
    it('maps key containing "password" to type "password"', () => {
      const field = firstField([entry('adminPassword', z.string())]) as ConfigPasswordField
      expect(field.type).toBe('password')
      expect(field.showToggle).toBe(true)
    })

    it('maps key containing "secret" to type "password"', () => {
      const field = firstField([entry('clientSecret', z.string())])
      expect(field.type).toBe('password')
    })

    it('maps key containing "token" to type "password"', () => {
      const field = firstField([entry('accessToken', z.string())])
      expect(field.type).toBe('password')
    })

    it('maps key containing "apikey" (case-insensitive) to type "password"', () => {
      const field = firstField([entry('apiKey', z.string())])
      expect(field.type).toBe('password')
    })
  })

  describe('ZodNumber → number field', () => {
    it('maps ZodNumber to type "number"', () => {
      const field = firstField([
        entry('port', z.number().describe('Port'), 8080),
      ]) as ConfigNumberField
      expect(field.type).toBe('number')
      expect(field.key).toBe('port')
    })

    it('extracts min and max from ZodNumber checks', () => {
      const field = firstField([entry('volume', z.number().min(0).max(100))]) as ConfigNumberField
      expect(field.min).toBe(0)
      expect(field.max).toBe(100)
    })

    it('extracts step (multipleOf) from ZodNumber checks', () => {
      const field = firstField([entry('step', z.number().multipleOf(5))]) as ConfigNumberField
      expect(field.step).toBe(5)
    })

    it('produces no min/max when no constraints on ZodNumber', () => {
      const field = firstField([entry('count', z.number())]) as ConfigNumberField
      expect(field.min).toBeUndefined()
      expect(field.max).toBeUndefined()
    })
  })

  describe('ZodBoolean → boolean field', () => {
    it('maps ZodBoolean to type "boolean"', () => {
      const field = firstField([
        entry('enabled', z.boolean().describe('Enable feature'), true),
      ]) as ConfigBooleanField
      expect(field.type).toBe('boolean')
      expect(field.key).toBe('enabled')
      expect(field.label).toBe('Enable feature')
    })
  })

  describe('ZodEnum → select field', () => {
    it('maps ZodEnum to type "select"', () => {
      const field = firstField([
        entry('resolution', z.enum(['4k', '1080p', '720p']).describe('Resolution'), '1080p'),
      ]) as ConfigSelectField
      expect(field.type).toBe('select')
      expect(field.key).toBe('resolution')
    })

    it('populates options from enum values', () => {
      const field = firstField([
        entry('codec', z.enum(['h264', 'h265', 'av1'])),
      ]) as ConfigSelectField
      expect(field.options).toHaveLength(3)
      expect(field.options.map((o) => o.value)).toEqual(['h264', 'h265', 'av1'])
    })

    it('humanizes option labels', () => {
      const field = firstField([
        entry('mode', z.enum(['auto_mode', 'manual_mode'])),
      ]) as ConfigSelectField
      expect(field.options[0]!.label).toBe('Auto mode')
      expect(field.options[1]!.label).toBe('Manual mode')
    })
  })

  describe('ZodDefault wrapper', () => {
    it('extracts default value from ZodDefault<ZodString>', () => {
      const field = firstField([entry('host', z.string().default('192.168.10.1'))])
      expect(field.default).toBe('192.168.10.1')
    })

    it('extracts default value from ZodDefault<ZodNumber>', () => {
      const field = firstField([entry('port', z.number().default(554))])
      expect(field.default).toBe(554)
    })

    it('still maps inner type correctly for ZodDefault<ZodBoolean>', () => {
      const field = firstField([entry('flag', z.boolean().default(true))])
      expect(field.type).toBe('boolean')
      expect(field.default).toBe(true)
    })

    it('still maps inner type correctly for ZodDefault<ZodEnum>', () => {
      const field = firstField([entry('codec', z.enum(['h264', 'h265']).default('h264'))])
      expect(field.type).toBe('select')
      expect(field.default).toBe('h264')
    })
  })

  describe('ZodOptional / ZodNullable wrappers', () => {
    it('unwraps ZodOptional and still returns correct type', () => {
      const field = firstField([entry('host', z.string().optional())])
      expect(field.type).toBe('text')
    })

    it('unwraps ZodNullable and still returns correct type', () => {
      const field = firstField([entry('count', z.number().nullable())])
      expect(field.type).toBe('number')
    })

    it('unwraps nested wrappers (nullable optional)', () => {
      const field = firstField([entry('flag', z.boolean().optional().nullable())])
      expect(field.type).toBe('boolean')
    })

    it('returns undefined default when no ZodDefault wrapper', () => {
      const field = firstField([entry('host', z.string().optional())])
      expect(field.default).toBeUndefined()
    })
  })

  describe('fallback for unknown types', () => {
    // Arrays and nested objects used to fall back to a plain `text` input
    // that rendered as `[object Object],[object Object]`, which drove the
    // RtspCamera/streams regression earlier in this session. They now
    // fall back to `textarea` with `isJson: true` so the JSON is editable
    // as text without clobbering the value on serialization.
    it('falls back to "textarea" (isJson) for ZodObject', () => {
      const field = firstField([entry('meta', z.object({ foo: z.string() }))])
      expect(field.type).toBe('textarea')
      expect((field as { isJson?: boolean }).isJson).toBe(true)
    })

    it('falls back to "textarea" (isJson) for ZodArray', () => {
      const field = firstField([entry('tags', z.array(z.string()))])
      expect(field.type).toBe('textarea')
      expect((field as { isJson?: boolean }).isJson).toBe(true)
    })
  })

  describe('label humanization', () => {
    it('converts camelCase to Title Case words', () => {
      const field = firstField([entry('maxRetryCount', z.number())])
      expect(field.label).toBe('Max Retry Count')
    })

    it('converts snake_case to sentence case words', () => {
      const field = firstField([entry('max_retry_count', z.number())])
      expect(field.label).toBe('Max retry count')
    })

    it('prefers description over humanized key', () => {
      const field = firstField([entry('rtspUrl', z.string().describe('RTSP stream URL'))])
      expect(field.label).toBe('RTSP stream URL')
    })
  })

  describe('integration: full device schema', () => {
    it('converts a realistic device schema to ConfigUISchema', () => {
      const entries: DeviceConfigEntry[] = [
        {
          key: 'host',
          schema: z.string().default('192.168.10.100').describe('Camera host'),
          value: '192.168.10.100',
          description: 'Camera host',
        },
        {
          key: 'port',
          schema: z.number().min(1).max(65535).default(554).describe('RTSP port'),
          value: 554,
          description: 'RTSP port',
        },
        {
          key: 'username',
          schema: z.string().default('admin').describe('Username'),
          value: 'admin',
          description: 'Username',
        },
        {
          key: 'password',
          schema: z.string().default('').describe('Password'),
          value: '',
          description: 'Password',
        },
        {
          key: 'subStream',
          schema: z.boolean().default(false).describe('Use sub-stream'),
          value: false,
          description: 'Use sub-stream',
        },
        {
          key: 'codec',
          schema: z.enum(['h264', 'h265']).default('h264').describe('Video codec'),
          value: 'h264',
          description: 'Video codec',
        },
      ]

      const result = zodEntriesToConfigUI(entries, 'Camera Settings', 'camera')
      const fields = result.sections[0]!.fields

      expect(fields).toHaveLength(6)

      const hostField = fields[0]! as ConfigTextField
      expect(hostField.type).toBe('text')

      const portField = fields[1]! as ConfigNumberField
      expect(portField.type).toBe('number')
      expect(portField.min).toBe(1)
      expect(portField.max).toBe(65535)

      const usernameField = fields[2]! as ConfigTextField
      expect(usernameField.type).toBe('text')

      const passwordField = fields[3]! as ConfigPasswordField
      expect(passwordField.type).toBe('password')

      const subStreamField = fields[4]! as ConfigBooleanField
      expect(subStreamField.type).toBe('boolean')

      const codecField = fields[5]! as ConfigSelectField
      expect(codecField.type).toBe('select')
      expect(codecField.options).toHaveLength(2)
    })
  })
})
