import type { DeviceType } from '../types'

// Azerbaijani labels for the type dropdown.
export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  router: 'Router',
  switch: 'Switch',
  server: 'Server',
  firewall: 'Firewall',
  access_point: 'Access Point',
  other: 'Digər',
}

export const DEVICE_TYPES: DeviceType[] = [
  'router', 'switch', 'server', 'firewall', 'access_point', 'other',
]

// Inline SVG path markup per type (Lucide-style, stroke-based). Embedded into an
// <svg> whose stroke is set at render time. No external assets → fully offline.
const GLYPH: Record<DeviceType, string> = {
  router:
    '<rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6.01 18H6.01"/><path d="M10.01 18H10.01"/><path d="M15 10v4"/><path d="M17.84 7.17a4 4 0 0 0-5.66 0"/><path d="M20.66 4.34a8 8 0 0 0-11.31 0"/>',
  switch:
    '<rect x="2" y="8" width="20" height="9" rx="2"/><path d="M6 12.5h.01M10 12.5h.01M14 12.5h.01M18 12.5h.01"/>',
  server:
    '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
  firewall:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M3 15h18M8 3v6M16 9v6M8 15v6"/>',
  access_point:
    '<path d="M5 12.55a8 8 0 0 1 14 0"/><path d="M8.5 16.43a4 4 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M12 20h.01"/>',
  other:
    '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
}

/** Full <svg> string for a type, stroked with the given color. */
export function deviceGlyphSvg(type: DeviceType, color: string, px = 18): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `${GLYPH[type] ?? GLYPH.other}</svg>`
  )
}
