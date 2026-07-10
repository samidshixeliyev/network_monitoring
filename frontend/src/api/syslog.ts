import { apiClient } from './client'
import type { PaginatedSyslog } from '../types'

export interface SyslogFilters {
  deviceId?: string
  host?: string
  maxSeverity?: number
  q?: string
}

export async function fetchSyslog(
  page: number,
  pageSize = 50,
  filters: SyslogFilters = {},
): Promise<PaginatedSyslog> {
  const { data } = await apiClient.get<PaginatedSyslog>('/syslog', {
    params: {
      page,
      page_size: pageSize,
      ...(filters.deviceId ? { device_id: filters.deviceId } : {}),
      ...(filters.host ? { host: filters.host } : {}),
      ...(filters.maxSeverity != null ? { max_severity: filters.maxSeverity } : {}),
      ...(filters.q ? { q: filters.q } : {}),
    },
  })
  return data
}
