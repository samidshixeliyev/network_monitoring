import { apiClient } from './client'
import type { Device, DeviceType, DiscoveredDevice, DiscoveryStatus } from '../types'

export interface ApproveBody {
  vendor_name?: string
  device_type?: DeviceType
  is_critical?: boolean
  latitude?: number | null
  longitude?: number | null
  location_text?: string | null
}

export const discoveryApi = {
  status: async (): Promise<DiscoveryStatus> => {
    const { data } = await apiClient.get<DiscoveryStatus>('/discovery/status')
    return data
  },
  list: async (includeIgnored = false): Promise<DiscoveredDevice[]> => {
    const { data } = await apiClient.get<DiscoveredDevice[]>('/discovery', {
      params: { include_ignored: includeIgnored },
    })
    return data
  },
  sweep: async (): Promise<{ swept: number; alive: number; new: number }> => {
    const { data } = await apiClient.post('/discovery/sweep', {})
    return data
  },
  approve: async (id: string, body: ApproveBody = {}): Promise<Device> => {
    const { data } = await apiClient.post<Device>(`/discovery/${id}/approve`, body)
    return data
  },
  ignore: async (id: string): Promise<DiscoveredDevice> => {
    const { data } = await apiClient.post<DiscoveredDevice>(`/discovery/${id}/ignore`, {})
    return data
  },
  remove: async (id: string): Promise<void> => {
    await apiClient.delete(`/discovery/${id}`)
  },
}
