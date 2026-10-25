import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { installDialogPolyfill } from '../../device/customize/assignments/__tests__/dialog-polyfill'

// The broker dialogs are the library `<Dialog>` — a native `<dialog>` jsdom
// cannot open on its own.
installDialogPolyfill()

afterEach(() => {
  cleanup()
})
