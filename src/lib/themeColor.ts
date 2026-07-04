/**
 * Keep the browser-chrome color (<meta name="theme-color">) in step with the
 * app theme. The theme is class-driven (§21.9), so the OS-media metas in
 * index.html are only right until the app picks its own theme — after that we
 * pin every theme-color meta to the app's actual background so phone browser
 * chrome never clashes with the surface.
 */
export function syncThemeColorMeta(dark: boolean): void {
  const color = dark ? '#0B0618' : '#FAFAFC'
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.setAttribute('content', color))
}
