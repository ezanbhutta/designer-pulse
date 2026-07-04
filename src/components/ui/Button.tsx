import { forwardRef, type ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BASE =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl px-4 text-sm transition-[background-color,border-color,color,opacity] duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50'

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-brand font-semibold text-brand-fg hover:opacity-90',
  secondary: 'border border-border bg-surface font-medium text-fg hover:bg-surface-2',
  ghost: 'font-medium text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger font-semibold text-danger-fg hover:opacity-90',
}

/** The one button recipe, for elements that can't be a <button> (links). */
export function buttonClasses(variant: ButtonVariant = 'secondary', extra = ''): string {
  return `${BASE} ${VARIANT_CLASSES[variant]}${extra ? ` ${extra}` : ''}`
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

/**
 * Shared button primitive (§21 design system): one place for the primary /
 * secondary / ghost / danger recipes instead of hand-rolled class strings.
 * Every variant is a ≥44px target with a visible disabled state and works in
 * both themes (semantic tokens only). Defaults to type="button" so buttons
 * inside forms never submit by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', className = '', type = 'button', ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={buttonClasses(variant, className)} {...rest} />
})

export default Button
