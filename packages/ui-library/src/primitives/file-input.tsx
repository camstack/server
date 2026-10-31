import {
  type InputHTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cn } from '../lib/cn'

export interface FileInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {}

/**
 * The picker behind a `Button`: always visually hidden. The caller keeps a ref
 * and opens it with `ref.current?.click()` from a library `Button`.
 */
export const FileInput: ForwardRefExoticComponent<
  FileInputProps & RefAttributes<HTMLInputElement>
> = forwardRef<HTMLInputElement, FileInputProps>(({ className, ...props }, ref) => (
  <input ref={ref} type="file" className={cn('hidden', className)} {...props} />
))

FileInput.displayName = 'FileInput'
