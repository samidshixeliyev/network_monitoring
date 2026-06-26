export type DeviceStatus = 'online' | 'offline' | 'unknown'
export type DeviceType = 'router' | 'switch' | 'server' | 'firewall' | 'access_point' | 'other'
export type EventType = 'came_online' | 'went_offline'
export type UserRole = 'manager' | 'user'

export interface Device {
  id: string
  vendor_name: string
  ip_address: string
  model_name: string | null
  description: string | null
  location_text: string | null
  latitude: number | null
  longitude: number | null
  device_type: DeviceType
  is_critical: boolean
  is_enabled: boolean
  current_status: DeviceStatus
  last_checked_at: string | null
  // SSH telemetry (read-only; password never returned)
  ssh_enabled: boolean
  ssh_port: number
  ssh_username: string | null
  ssh_status: string
  ssh_hostname: string | null
  ssh_uptime: string | null
  ssh_facts: string | null
  ssh_collected_at: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface SshInterface { name: string; ipv4: string }
export interface SshFacts {
  interfaces?: SshInterface[]
  kernel?: string | null
}
export interface SshCheckResult {
  status: string
  detail?: string | null
  hostname?: string | null
  uptime?: string | null
  facts?: SshFacts | null
}

export interface DeviceCreate {
  vendor_name: string
  ip_address: string
  model_name?: string
  description?: string
  location_text?: string
  device_type?: DeviceType
  is_critical?: boolean
  latitude?: number | null
  longitude?: number | null
  is_enabled?: boolean
  ssh_enabled?: boolean
  ssh_port?: number
  ssh_username?: string | null
  ssh_password?: string | null
}

export type DeviceUpdate = Partial<DeviceCreate>

export interface EventLog {
  id: string
  device_id: string
  event_type: EventType
  created_at: string
}

export interface PaginatedEvents {
  total: number
  items: EventLog[]
}

export interface TokenResponse {
  access_token: string
  token_type: string
  email: string
  role: UserRole
}

export interface AuthUser {
  token: string
  email: string
  role: UserRole
}

export interface WsStatusMessage {
  device_id: string
  status: DeviceStatus
  last_checked_at: string
}
