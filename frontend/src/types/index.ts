export type DeviceStatus = 'online' | 'offline' | 'unknown'
export type DeviceType = 'router' | 'switch' | 'server' | 'firewall' | 'access_point' | 'other'
export type EventType = 'came_online' | 'went_offline'
// Roles are server-defined named bundles of permissions; keep this open.
export type UserRole = 'manager' | 'engineer' | 'operator' | 'viewer' | 'user' | string

// Permission names returned by the backend (authoritative gate lives there).
export type Permission =
  | 'view' | 'ssh' | 'ack' | 'mute' | 'edit_device' | 'edit_config' | 'manage_users'

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
  // Topology / maintenance / ack-mute / multi-condition (Priority 7)
  parent_id: string | null
  maintenance_until: string | null
  is_muted: boolean
  alarm_acked_at: string | null
  check_tcp_port: number | null
  check_http_url: string | null
  check_http_expect: number | null
  service_ok: boolean | null
  service_detail: string | null
  // SSH telemetry (read-only; password never returned)
  ssh_enabled: boolean
  ssh_port: number
  ssh_username: string | null
  ssh_status: string
  ssh_hostname: string | null
  ssh_uptime: string | null
  ssh_facts: string | null
  ssh_collected_at: string | null
  // SNMP telemetry (read-only; community string never returned)
  snmp_enabled: boolean
  snmp_port: number
  snmp_version: string
  snmp_status: string
  snmp_facts: string | null
  snmp_collected_at: string | null
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

export interface SnmpInterface {
  index: number
  name: string
  oper: 'up' | 'down'
  speed_mbps: number | null
  in_bps: number | null
  out_bps: number | null
}
export interface SnmpFacts {
  sys_name?: string | null
  sys_descr?: string | null
  uptime?: string | null
  cpu_percent?: number | null
  mem_percent?: number | null
  interfaces?: SnmpInterface[]
}
export interface SnmpCheckResult {
  status: string
  detail?: string | null
  facts?: SnmpFacts | null
}
export interface SnmpHistoryPoint {
  ts: string
  cpu_percent: number | null
  mem_percent: number | null
  in_bps: number | null
  out_bps: number | null
}

export interface PingNowResult {
  alive: boolean
  rtts_ms: number[]
  packets_sent: number
  packets_received: number
  packet_loss_pct: number
  min_ms: number | null
  avg_ms: number | null
  max_ms: number | null
}
export interface TraceHop {
  distance: number
  address: string | null
  rtt_ms: number | null
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
  parent_id?: string | null
  check_tcp_port?: number | null
  check_http_url?: string | null
  check_http_expect?: number | null
  snmp_enabled?: boolean
  snmp_port?: number
  snmp_community?: string | null
}

export type DeviceUpdate = Partial<DeviceCreate>

export interface DeviceSla {
  device_id: string
  vendor_name: string
  ip_address: string
  region: string | null
  is_critical: boolean
  uptime_pct: number
  samples: number
}
export interface RegionSla {
  region: string
  uptime_pct: number
  devices: number
  samples: number
}
export interface SlaReport {
  range: string
  devices: DeviceSla[]
  regions: RegionSla[]
}
export interface MonitorStatus {
  heartbeat: string | null
  age_seconds: number | null
  healthy: boolean
}

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
  permissions: string[]
}

export interface AuthUser {
  token: string
  email: string
  role: UserRole
  permissions: string[]
}

export interface WsStatusMessage {
  device_id: string
  status: DeviceStatus
  last_checked_at: string
}

export interface HistoryPoint {
  ts: string
  avg_rtt_ms: number | null
  uptime_pct: number
  samples: number
}

// The gateway coalesces status changes into a single batch frame (~250ms window).
export interface WsBatchMessage {
  type: 'batch'
  changes: WsStatusMessage[]
}
