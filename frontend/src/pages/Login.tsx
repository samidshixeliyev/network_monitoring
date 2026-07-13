import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { useAuth } from '../hooks/useAuth'

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await login(email, password)
      navigate('/')
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        setError('Həddindən çox uğursuz cəhd. Bir neçə dəqiqə gözləyib yenidən yoxlayın.')
      } else {
        setError('E-poçt və ya parol yanlışdır')
      }
    } finally {
      setLoading(false)
    }
  }

  const inp: React.CSSProperties = {
    width: '100%', padding: '9px 12px', border: '1px solid #e2e8f0',
    borderRadius: 6, fontSize: 14, boxSizing: 'border-box', fontFamily: 'inherit',
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9' }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 36, width: 380, boxShadow: '0 4px 24px rgba(0,0,0,0.1)' }}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 700, color: '#1e293b' }}>
            Şəbəkə Monitoru
          </h1>
          <p style={{ margin: 0, color: '#64748b', fontSize: 14 }}>Hesabınıza daxil olun</p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4, color: '#374151' }}>
              E-poçt
            </label>
            <input type="email" required style={inp} value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4, color: '#374151' }}>
              Parol
            </label>
            <input type="password" required style={inp} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>

          {error && <p style={{ color: '#dc2626', fontSize: 13, margin: 0 }}>{error}</p>}

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '10px', borderRadius: 6, border: 'none',
              background: '#1e40af', color: '#fff', cursor: 'pointer',
              fontSize: 14, fontWeight: 600, marginTop: 4,
              opacity: loading ? 0.7 : 1, fontFamily: 'inherit',
            }}
          >
            {loading ? 'Daxil olunur…' : 'Daxil ol'}
          </button>
        </form>
      </div>
    </div>
  )
}
