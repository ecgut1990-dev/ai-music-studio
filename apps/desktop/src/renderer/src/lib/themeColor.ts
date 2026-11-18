/** a colour of the current look (Settings → Appearance), for drawings on a canvas, which cannot read CSS variables */
export function themeColor(name: string, fallback: string): string {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback } catch { return fallback }
}
