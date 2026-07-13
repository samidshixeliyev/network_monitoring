import { apiClient } from './client'
import type { DeviceLink, DeviceLinkKind } from '../types'

export interface CreateLinkBody {
  source_id: string
  target_id: string
  kind?: DeviceLinkKind
  label?: string | null
}

export const deviceLinksApi = {
  list: async (): Promise<DeviceLink[]> => {
    const { data } = await apiClient.get<DeviceLink[]>('/device-links')
    return data
  },
  create: async (body: CreateLinkBody): Promise<DeviceLink> => {
    const { data } = await apiClient.post<DeviceLink>('/device-links', body)
    return data
  },
  remove: async (id: string): Promise<void> => {
    await apiClient.delete(`/device-links/${id}`)
  },
}
