import { apiClient } from './client'
import type { Device, DeviceCreate, DeviceUpdate, HistoryPoint, SshCheckResult } from '../types'

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
  sshCheck: async (id: string): Promise<SshCheckResult> => {
    const { data } = await apiClient.post<SshCheckResult>(`/devices/${id}/ssh-check`, {})
    return data
  },
  history: async (id: string, range = '24h'): Promise<HistoryPoint[]> => {
    const { data } = await apiClient.get<HistoryPoint[]>(`/devices/${id}/history`, {
      params: { range },
    })
    return data
  },
}
