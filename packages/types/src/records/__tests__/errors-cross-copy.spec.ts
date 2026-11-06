import { describe, expect, it } from 'vitest'
import {
  DeclarationRefusedError,
  RecordsError,
  RecordTooLargeError,
  RevConflictError,
  asRecordsError,
} from '../errors'

/** What another bundled copy of this module throws: not built by these classes. */
function foreignRecordsError(code: string): Error {
  const foreign = new Error(`records/${code}: from the host`)
  return Object.assign(foreign, { code, [Symbol.for('camstack.records-error')]: true })
}

describe('records errors across copies of @camstack/types', () => {
  it('a foreign rev-conflict is a RevConflictError and a RecordsError, not another subclass', () => {
    const foreign = foreignRecordsError('rev-conflict')
    expect(foreign instanceof RevConflictError).toBe(true)
    expect(foreign instanceof RecordsError).toBe(true)
    expect(foreign instanceof RecordTooLargeError).toBe(false)
    expect(foreign instanceof DeclarationRefusedError).toBe(false)
  })

  it('an unbranded error is none of them, even with a matching code', () => {
    const plain = Object.assign(new Error('records/rev-conflict: x'), { code: 'rev-conflict' })
    expect(plain instanceof RecordsError).toBe(false)
    expect(plain instanceof RevConflictError).toBe(false)
  })

  it('same-copy instances keep their answers', () => {
    const own = new RevConflictError('x')
    expect(own instanceof RevConflictError).toBe(true)
    expect(own instanceof RecordsError).toBe(true)
    expect(own instanceof RecordTooLargeError).toBe(false)
    expect(asRecordsError(foreignRecordsError('declaration-refused')) instanceof DeclarationRefusedError).toBe(true)
  })
})
