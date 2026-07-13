import { apiClient } from './client'
import type {
  Device, DeviceCreate, DeviceUpdate, HistoryPoint, PingNowResult,
  SnmpCheckResult, SnmpHistoryPoint, SnmpInventoryResult, SshCheckResult, TraceHop,
} from '../types'

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
  pingNow: async (id: string, count = 4): Promise<PingNowResult> => {
    const { data } = await apiClient.post<PingNowResult>(`/devices/${id}/ping`, { count })
    return data
  },
  traceroute: async (id: string): Promise<TraceHop[]> => {
    const { data } = await apiClient.post<TraceHop[]>(`/devices/${id}/traceroute`, {})
    return data
  },
  snmpCheck: async (id: string): Promise<SnmpCheckResult> => {
    const { data } = await apiClient.post<SnmpCheckResult>(`/devices/${id}/snmp-check`, {})
    return data
  },
  // Live read-only poll for the traffic modal — persists nothing, safe ~1×/s.
  snmpPeek: async (id: string): Promise<SnmpCheckResult> => {
    const { data } = await apiClient.post<SnmpCheckResult>(`/devices/${id}/snmp-peek`, {})
    return data
  },
  // Comprehensive on-demand SNMP walk (system/disk/interfaces/sensors/VLAN/MAC/
  // ARP/routing/QoS/VPN/wireless/UPS). Persists nothing — backs the Explorer.
  snmpInventory: async (id: string): Promise<SnmpInventoryResult> => {
    const { data } = await apiClient.post<SnmpInventoryResult>(`/devices/${id}/snmp-inventory`, {})
    return data
  },
  snmpHistory: async (id: string, range = '24h'): Promise<SnmpHistoryPoint[]> => {
    const { data } = await apiClient.get<SnmpHistoryPoint[]>(`/devices/${id}/snmp/history`, {
      params: { range },
    })
    return data
  },
  history: async (id: string, range = '24h'): Promise<HistoryPoint[]> => {
    const { data } = await apiClient.get<HistoryPoint[]>(`/devices/${id}/history`, {
      params: { range },
    })
    return data
  },
  ack: async (id: string): Promise<Device> => {
    const { data } = await apiClient.post<Device>(`/devices/${id}/ack`, {})
    return data
  },
  mute: async (id: string, muted: boolean): Promise<Device> => {
    const { data } = await apiClient.post<Device>(`/devices/${id}/mute`, { muted })
    return data
  },
  maintenance: async (id: string, minutes: number | null): Promise<Device> => {
    const { data } = await apiClient.post<Device>(`/devices/${id}/maintenance`, { minutes })
    return data
  },
}
