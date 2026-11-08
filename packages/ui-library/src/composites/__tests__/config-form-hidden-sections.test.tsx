// @vitest-environment jsdom
/**
 * A section whose every field is hidden by `showWhen` is not drawn: a per-provider section of a
 * provider that is not selected would otherwise be a bare header.
 */
import type { ConfigUISchema } from '@camstack/types'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigFormBuilder } from '../config-form-builder.js'

afterEach(() => cleanup())

const SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'provider',
      title: 'Provider section',
      columns: 1,
      fields: [
        {
          type: 'select',
          key: 'providerId',
          label: 'Provider',
          options: [
            { value: 'filesystem', label: 'Filesystem' },
            { value: 's3', label: 'S3' },
          ],
        },
      ],
    },
    {
      id: 'filesystem',
      title: 'Filesystem section',
      columns: 1,
      fields: [
        {
          type: 'text',
          key: 'filesystem.basePath',
          label: 'Base path',
          showWhen: { field: 'providerId', equals: 'filesystem' },
        },
      ],
    },
    {
      id: 's3',
      title: 'S3 section',
      columns: 1,
      fields: [
        {
          type: 'text',
          key: 's3.bucket',
          label: 'Bucket',
          showWhen: { field: 'providerId', equals: 's3' },
        },
      ],
    },
    { id: 'empty', title: 'Declared empty', columns: 1, fields: [] },
  ],
}

function renderWith(providerId: string, bare = false) {
  return render(
    <ConfigFormBuilder
      schema={SCHEMA}
      values={{ providerId }}
      onChange={() => undefined}
      bare={bare}
    />,
  )
}

describe('ConfigFormBuilder hides sections with no visible field', () => {
  it('draws only the selected provider section', () => {
    renderWith('s3')
    expect(screen.getByText('S3 section')).toBeTruthy()
    expect(screen.queryByText('Filesystem section')).toBeNull()
    expect(screen.getByText('Provider section')).toBeTruthy()
  })

  it('follows the selection', () => {
    renderWith('filesystem')
    expect(screen.getByText('Filesystem section')).toBeTruthy()
    expect(screen.queryByText('S3 section')).toBeNull()
  })

  it('keeps a section the author declared with no fields', () => {
    renderWith('s3')
    expect(screen.getByText('Declared empty')).toBeTruthy()
  })

  it('bare mode draws no field of a hidden section', () => {
    renderWith('s3', true)
    expect(screen.queryByText('Base path')).toBeNull()
    expect(screen.getByText('Bucket')).toBeTruthy()
  })
})
