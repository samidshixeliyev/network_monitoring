import { apiClient } from './client'

// Admin panel API — user + role management. Backend gate: manage_users.

export interface AdminRole {
  id: number
  name: string
  builtin: boolean
  permissions: string[]
  users: number
}

export interface AdminUser {
  id: string
  email: string
  role: string
  is_active: boolean
}

export const adminApi = {
  permissions: async (): Promise<string[]> => {
    const { data } = await apiClient.get<string[]>('/admin/permissions')
    return data
  },
  roles: async (): Promise<AdminRole[]> => {
    const { data } = await apiClient.get<AdminRole[]>('/admin/roles')
    return data
  },
  createRole: async (name: string, permissions: string[]): Promise<AdminRole> => {
    const { data } = await apiClient.post<AdminRole>('/admin/roles', { name, permissions })
    return data
  },
  updateRole: async (id: number, permissions: string[]): Promise<AdminRole> => {
    const { data } = await apiClient.patch<AdminRole>(`/admin/roles/${id}`, { permissions })
    return data
  },
  deleteRole: async (id: number): Promise<void> => {
    await apiClient.delete(`/admin/roles/${id}`)
  },
  users: async (): Promise<AdminUser[]> => {
    const { data } = await apiClient.get<AdminUser[]>('/admin/users')
    return data
  },
  createUser: async (email: string, password: string, role: string): Promise<AdminUser> => {
    const { data } = await apiClient.post<AdminUser>('/admin/users', { email, password, role })
    return data
  },
  updateUser: async (
    id: string,
    body: { role?: string; password?: string; is_active?: boolean },
  ): Promise<AdminUser> => {
    const { data } = await apiClient.patch<AdminUser>(`/admin/users/${id}`, body)
    return data
  },
  deleteUser: async (id: string): Promise<void> => {
    await apiClient.delete(`/admin/users/${id}`)
  },
}
