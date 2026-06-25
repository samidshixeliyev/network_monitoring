import { apiClient } from './client'
import type { Device, DeviceCreate, DeviceUpdate } from '../types'

export const devicesApi = {
  list: async (): Promise<Device[]> => {
    const { data } = await apiClient.get<Device[]>('/devices')
    return data
  },
  create: async (body: DeviceCreate): Promise<Device> => {
    const { data } = await apiClient.post<Device>('/devices', body)
    return data
  },
  update: async (id: string, body: DeviceUpdate): Promise<Device> => {
    const { data } = await apiClient.patch<Device>(`/devices/${id}`, body)
    return data
  },
  remove: async (id: string): Promise<void> => {
    await apiClient.delete(`/devices/${id}`)
  },
  simulate: async (id: string, status: 'online' | 'offline'): Promise<Device> => {
    const { data } = await apiClient.post<Device>(`/devices/${id}/simulate`, { status })
    return data
  },
}
