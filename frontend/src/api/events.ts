import { apiClient } from './client'
import type { PaginatedEvents } from '../types'

export async function fetchEvents(
  page: number,
  pageSize = 50,
  deviceId?: string,
): Promise<PaginatedEvents> {
  const { data } = await apiClient.get<PaginatedEvents>('/events', {
    params: {
      page,
      page_size: pageSize,
      ...(deviceId ? { device_id: deviceId } : {}),
    },
  })
  return data
}
