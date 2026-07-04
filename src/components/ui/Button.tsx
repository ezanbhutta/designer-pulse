import { forwardRef, type ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

/** The one control height (manifesto pillar 4): 40px, matching ActionButton
 *  and the `.input` recipe. Tactile press via active:scale (pillar 8). */
const BASE =
  'inline-flex h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-4 text-caption transition-[background-color,border-color,color,opacity,transform] duration-150 ease-out motion-safe:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-safe:disabled:active:scale-100'

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
 * Every variant is the standard 40px control with a tactile press, a visible
 * disabled state, and works in both themes (semantic tokens only). Defaults
 * to type="button" so buttons inside forms never submit by accident.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', className = '', type = 'button', ...rest },
  ref,
) {
  return <button ref={ref} type={type} className={buttonClasses(variant, className)} {...rest} />
})

export default Button
