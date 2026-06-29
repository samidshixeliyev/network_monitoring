import { apiClient } from './client'
import type { MonitorStatus, SlaReport } from '../types'

export async function fetchSla(range = 'week'): Promise<SlaReport> {
  const { data } = await apiClient.get<SlaReport>('/sla', { params: { range } })
  return data
}

export function slaExportUrl(range = 'week'): string {
  return `/api/sla/export?range=${encodeURIComponent(range)}`
}

export async function fetchHeartbeat(): Promise<MonitorStatus> {
  const { data } = await apiClient.get<MonitorStatus>('/monitor/heartbeat')
  return data
}
