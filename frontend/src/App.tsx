import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { Login } from './pages/Login'
import { Dashboard } from './pages/Dashboard'
import { EventLog } from './pages/EventLog'
import { AdminPanel } from './pages/AdminPanel'
import { Discovery } from './pages/Discovery'
import type { ReactNode } from 'react'

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
})

function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  return user ? <>{children}</> : <Navigate to="/login" replace />
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, hasPermission } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  // Backend enforces manage_users on every /api/admin call; this only routes.
  return hasPermission('manage_users') || user.role === 'manager'
    ? <>{children}</>
    : <Navigate to="/" replace />
}

function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  return user ? <Navigate to="/" replace /> : <>{children}</>
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <Router>
          <Routes>
            <Route
              path="/login"
              element={<RedirectIfAuthed><Login /></RedirectIfAuthed>}
            />
            <Route
              path="/"
              element={<RequireAuth><Dashboard /></RequireAuth>}
            />
            <Route
              path="/events"
              element={<RequireAuth><EventLog /></RequireAuth>}
            />
            <Route
              path="/discovery"
              element={<RequireAuth><Discovery /></RequireAuth>}
            />
            <Route
              path="/admin"
              element={<RequireAdmin><AdminPanel /></RequireAdmin>}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Router>
      </AuthProvider>
    </QueryClientProvider>
  )
}
