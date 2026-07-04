/** Semantic token architecture (§21.1): every color is an `R G B` triplet CSS
 *  variable consumed as `rgb(var(--token) / <alpha>)` so the whole UI retunes
 *  from src/index.css. Never use raw hex in components. */
const t = (name) => `rgb(var(--color-${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', './shared/**/*.ts'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: t('bg'),
        surface: t('surface'),
        'surface-2': t('surface-2'),
        border: t('border'),
        fg: t('fg'),
        muted: t('muted'),
        brand: t('brand'),
        'brand-fg': t('brand-fg'),
        'brand-soft': t('brand-soft'),
        success: t('success'),
        'success-soft': t('success-soft'),
        warning: t('warning'),
        'warning-soft': t('warning-soft'),
        danger: t('danger'),
        'danger-fg': t('danger-fg'),
        'danger-soft': t('danger-soft'),
      },
      /** Named overlay stack (one ordering contract, no magic z numbers):
       *  overlay (drawers/dialogs) < palette < toast < tip. */
      zIndex: {
        overlay: '50',
        palette: '55',
        toast: '60',
        tip: '70',
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
      boxShadow: {
        soft: '0 2px 12px rgba(22, 10, 51, 0.06)',
        raised: '0 14px 40px -12px rgba(22, 10, 51, 0.22)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        // Opacity-only fade for elements positioned with transform utilities
        // (e.g. the InfoTip note) — `fade-in` would override their transform.
        'tip-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        pulseOnce: {
          '0%': { boxShadow: '0 0 0 0 rgb(var(--color-brand) / 0.45)' },
          '100%': { boxShadow: '0 0 0 12px rgb(var(--color-brand) / 0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out both',
        'tip-in': 'tip-in 150ms ease-out',
        'pulse-once': 'pulseOnce 600ms ease-out 1',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
}
