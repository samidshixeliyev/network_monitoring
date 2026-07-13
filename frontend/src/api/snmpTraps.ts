import { apiClient } from './client'
import type { PaginatedSnmpTraps } from '../types'

export interface SnmpTrapFilters {
  deviceId?: string
  host?: string
  maxSeverity?: number
  q?: string
}

export async function fetchSnmpTraps(
  page: number,
  pageSize = 50,
  filters: SnmpTrapFilters = {},
): Promise<PaginatedSnmpTraps> {
  const { data } = await apiClient.get<PaginatedSnmpTraps>('/snmp-traps', {
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
