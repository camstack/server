import { describe, expect, it } from 'vitest'
import {
  addHeader,
  canAddHeader,
  expectOn,
  expectValueOf,
  headerRows,
  httpRetry,
  newHttpRequest,
  newProbe,
  probeSaveAs,
  removeHeader,
  renameHeader,
  setHeaderValue,
  wholeNumber,
} from '../reach-step-model'
import { newAction } from '../recipe-parts'

describe('reach step model', () => {
  it('starts from a valid blank step', () => {
    expect(newProbe()).toMatchObject({ kind: 'probe', port: 80 })
    expect(newHttpRequest()).toMatchObject({ kind: 'http-request', method: 'GET' })
    expect(newAction('probe').kind).toBe('probe')
    expect(newAction('http-request').kind).toBe('http-request')
  })

  it('drops a blank optional field instead of saving it empty', () => {
    const withName = probeSaveAs(newProbe(), 'ccu')
    expect(withName.saveAs).toBe('ccu')
    expect('saveAs' in probeSaveAs(withName, '')).toBe(false)
    expect('retryUntilSeconds' in httpRetry(newHttpRequest(), undefined)).toBe(false)
    expect(wholeNumber('')).toBeUndefined()
    expect(wholeNumber('12.7')).toBe(12)
  })

  it('edits headers as rows, refusing a duplicate name', () => {
    const one = addHeader(undefined)
    expect(canAddHeader(one)).toBe(false)
    const named = renameHeader(one, 0, 'Accept')
    const two = addHeader(setHeaderValue(named, 0, 'a/b'))
    expect(headerRows(two)).toEqual([
      { name: 'Accept', value: 'a/b' },
      { name: '', value: '' },
    ])
    expect(renameHeader(two, 1, 'accept')).toBe(two)
    expect(removeHeader(named, 0)).toBeUndefined()
  })

  it('reads the expectation value by what it is compared with', () => {
    expect(expectValueOf('status', '204')).toBe(204)
    expect(expectValueOf('json', 'true')).toBe(true)
    expect(expectValueOf('json', '3')).toBe(3)
    expect(expectValueOf('json', '')).toBe('')
    expect(expectOn({ on: 'status', operator: 'eq', value: 200 }, 'json')).toMatchObject({
      on: 'json',
      fieldPath: '',
    })
  })
})
