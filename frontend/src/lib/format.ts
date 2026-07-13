// Human-readable bits-per-second (SNMP interface traffic rates).
export function formatBps(bps: number | null | undefined): string {
  if (bps == null) return '—'
  if (bps >= 1e9) return (bps / 1e9).toFixed(1) + ' Gb/s'
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' Mb/s'
  if (bps >= 1e3) return (bps / 1e3).toFixed(1) + ' kb/s'
  return Math.round(bps) + ' b/s'
}

// Human-readable byte sizes (SNMP hrStorage disk/memory).
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return (i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i]
}
