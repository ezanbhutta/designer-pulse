/**
 * Aurora backdrop (Designer self-view): three large, blurred violet blooms that
 * drift slowly behind the content, giving the frosted glass-cards something
 * luminous to refract. Purely decorative — aria-hidden, pointer-events:none,
 * fixed behind everything (z-0). The brand is the only hue (manifesto pillar 1);
 * a whisper of cool blue keeps the gradient from looking flat. Under reduced
 * motion the global guard in index.css freezes the drift.
 *
 * Kept intentionally soft in the light theme (a designer glances at this on a
 * bright phone) and glowier over the void in dark.
 */
export function Aurora() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {/* One extra veil so the blooms never touch the readable text edges. */}
      <div
        className="absolute -inset-[20%] opacity-90 blur-[70px] dark:opacity-100"
        style={{ filter: 'blur(70px)' }}
      >
        <span
          className="absolute rounded-full"
          style={{
            width: '52vmax',
            height: '52vmax',
            left: '-12vmax',
            top: '-16vmax',
            background:
              'radial-gradient(circle at 40% 40%, rgba(114,41,255,0.42), transparent 60%)',
            animation: 'drift1 20s ease-in-out infinite',
          }}
        />
        <span
          className="absolute rounded-full"
          style={{
            width: '46vmax',
            height: '46vmax',
            right: '-10vmax',
            top: '4vmax',
            background:
              'radial-gradient(circle at 50% 50%, rgba(159,102,255,0.38), transparent 62%)',
            animation: 'drift2 24s ease-in-out infinite',
          }}
        />
        <span
          className="absolute rounded-full"
          style={{
            width: '40vmax',
            height: '40vmax',
            left: '18vmax',
            bottom: '-20vmax',
            background:
              'radial-gradient(circle at 50% 50%, rgba(80,160,255,0.22), transparent 60%)',
            animation: 'drift1 28s ease-in-out infinite reverse',
          }}
        />
      </div>
    </div>
  )
}

export default Aurora
