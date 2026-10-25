import { type ReactNode, type JSX } from 'react'
import { cn } from '../lib/cn'
import { Label } from '../primitives'

export interface FormFieldProps {
  label: string
  description?: string
  error?: string
  required?: boolean
  children: ReactNode
  orientation?: 'vertical' | 'horizontal'
  className?: string
}

export function FormField({
  label,
  description,
  error,
  required,
  children,
  orientation = 'vertical',
  className,
}: FormFieldProps): JSX.Element {
  const isHorizontal = orientation === 'horizontal'

  return (
    <div
      className={cn(
        'flex gap-2',
        isHorizontal ? 'flex-row items-center justify-between' : 'flex-col',
        className,
      )}
    >
      <div className={cn(isHorizontal ? 'flex-1' : '')}>
        <Label>
          {label}
          {required && <span className="text-danger ml-0.5">*</span>}
        </Label>
        {description && <p className="text-foreground-subtle text-xs mt-0.5">{description}</p>}
      </div>
      <div className={cn(isHorizontal ? 'shrink-0' : '')}>{children}</div>
      {error && <p className="text-danger text-xs">{error}</p>}
    </div>
  )
}
