import { apiClient } from './client'
import type { MonitorStatus, SlaReport } from '../types'

export async function fetchSla(range = 'week'): Promise<SlaReport> {
  const { data } = await apiClient.get<SlaReport>('/sla', { params: { range } })
  return data
}

// Download the SLA CSV THROUGH the axios client so the Authorization header is
// sent — the backend route requires auth, so a plain <a href> download returns
// 401 (the token lives in localStorage, not a cookie). We fetch a Blob and
// trigger a client-side download instead.
export async function downloadSlaExport(range = 'week'): Promise<void> {
  const { data } = await apiClient.get('/sla/export', {
    params: { range },
    responseType: 'blob',
  })
  const url = URL.createObjectURL(data as Blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `sla-${range}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export async function fetchHeartbeat(): Promise<MonitorStatus> {
  const { data } = await apiClient.get<MonitorStatus>('/monitor/heartbeat')
  return data
}
