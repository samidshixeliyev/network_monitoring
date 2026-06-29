import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react'
import { login as apiLogin } from '../api/auth'
import type { AuthUser } from '../types'

interface AuthContextValue {
  user: AuthUser | null
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  isManager: boolean
  hasPermission: (permission: string) => boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

function loadUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem('user')
    return raw ? (JSON.parse(raw) as AuthUser) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(loadUser)

  const login = useCallback(async (email: string, password: string) => {
    const res = await apiLogin(email, password)
    const authUser: AuthUser = {
      token: res.access_token,
      email: res.email,
      role: res.role,
      permissions: res.permissions ?? [],
    }
    localStorage.setItem('token', res.access_token)
    localStorage.setItem('user', JSON.stringify(authUser))
    setUser(authUser)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setUser(null)
  }, [])

  const hasPermission = useCallback(
    (permission: string) => !!user?.permissions?.includes(permission),
    [user],
  )

  return (
    <AuthContext.Provider
      value={{
        user,
        login,
        logout,
        // Authoritative gate is the backend; these only toggle UI affordances.
        isManager: !!user?.permissions?.includes('manage_users') || user?.role === 'manager',
        hasPermission,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
