import { describe, expect, it } from 'vitest'
import { looksUserVisible, scanSource } from '../i18n/find-untranslated-admin'

const scan = (body: string) => scanSource('x.tsx', body).map((f) => f.text)

describe('admin i18n census', () => {
  it('flags JSX prose and a bare lowercase word', () => {
    expect(scan('const A = () => <p>Save the file</p>')).toEqual(['Save the file'])
    expect(scan('const A = () => <b>offline</b>')).toEqual(['offline'])
  })

  it('does not flag ids, urls or translated text', () => {
    expect(looksUserVisible('camera-1')).toBe(false)
    expect(looksUserVisible('/system/users')).toBe(false)
    expect(scan("const A = () => <p>{t('a.b', 'Save the file')}</p>")).toEqual([])
  })

  it('exempts a line marked i18n-ignore, the next line, and a block', () => {
    expect(
      scan('const A = () => (\n  <p>\n    {/* i18n-ignore: brand */}\n    Reolink\n  </p>\n)'),
    ).toEqual([])
    expect(
      scan(
        "// i18n-ignore-start: brand names\nconst P = { a: { label: 'Hikvision' } }\n// i18n-ignore-end\nconst Q = { label: 'Hello there' }",
      ),
    ).toEqual(['Hello there'])
  })
})
