/** The `servers` kind: the credential is a secret path, the body shape is checked by the schema. */
import { describe, expect, it } from 'vitest'
import {
  TURN_DEFAULT_BODY,
  TurnServerBodySchema,
  staticTurnServersKind,
} from '../turn-record-kinds.js'

describe('staticTurnServersKind', () => {
  it('marks the credential (and only it) as a keychain secret', () => {
    expect(staticTurnServersKind.declaration.secretPaths).toEqual(['credential'])
  })

  it('names the row by its name field', () => {
    expect(staticTurnServersKind.declaration.entry?.nameField).toBe('name')
  })

  it('rejects a body without urls or with a non-text urls', () => {
    expect(TurnServerBodySchema.safeParse({ name: 'x', username: '' }).success).toBe(false)
    expect(TurnServerBodySchema.safeParse({ name: 'x', urls: 42, username: '' }).success).toBe(
      false,
    )
    expect(TurnServerBodySchema.safeParse({ name: '', urls: 'turn:a', username: '' }).success).toBe(
      false,
    )
  })

  it('accepts the default body, which is an unconfigured server', () => {
    expect(TurnServerBodySchema.safeParse({ name: 'x', ...TURN_DEFAULT_BODY }).success).toBe(true)
    expect(TURN_DEFAULT_BODY.urls).toBe('')
  })
})
