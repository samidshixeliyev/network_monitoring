// Tiny Web Audio alerts — no audio files needed (works fully offline).
let ctx: AudioContext | null = null

function audioCtx(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new Ctor()
  }
  return ctx
}

function tone(a: AudioContext, freq: number, start: number, dur: number, gainV: number, type: OscillatorType = 'sine') {
  const t0 = a.currentTime
  const osc = a.createOscillator()
  const gain = a.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, t0 + start)
  gain.gain.linearRampToValueAtTime(gainV, t0 + start + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur)
  osc.connect(gain)
  gain.connect(a.destination)
  osc.start(t0 + start)
  osc.stop(t0 + start + dur + 0.02)
}

export type AlertKind = 'down' | 'up' | 'critical'

// Alerts repeat to fill this many seconds so a down/up event is clearly audible
// (5–7s window requested). Kept as a constant so all kinds share the length.
const ALERT_SECONDS = 6

/**
 * Play a status alert — each lasts ~6s (repeating pattern) so it is hard to miss.
 *  - `critical` → loud, urgent repeating square-wave siren (important devices)
 *  - `down`     → descending two-tone alarm, repeated
 *  - `up`       → gentle ascending chime, repeated (recovery)
 */
export function playAlert(kind: AlertKind): void {
  try {
    const a = audioCtx()
    if (a.state === 'suspended') void a.resume()

    if (kind === 'critical') {
      // Fast alternating high tones, louder — repeated for the full window.
      const step = 0.16
      const n = Math.floor(ALERT_SECONDS / step)
      for (let i = 0; i < n; i++) {
        tone(a, i % 2 ? 784 : 1046, i * step, 0.14, 0.34, 'square')
      }
    } else if (kind === 'down') {
      // Descending high→low two-tone, one cycle every 0.6s, repeated ~10x.
      const cycle = 0.6
      const n = Math.floor(ALERT_SECONDS / cycle)
      for (let i = 0; i < n; i++) {
        tone(a, 880, i * cycle, 0.20, 0.20)
        tone(a, 440, i * cycle + 0.28, 0.28, 0.20)
      }
    } else {
      // Recovery: pleasant ascending low→high chime, repeated, softer.
      const cycle = 0.7
      const n = Math.floor(ALERT_SECONDS / cycle)
      for (let i = 0; i < n; i++) {
        tone(a, 523, i * cycle, 0.18, 0.12)
        tone(a, 784, i * cycle + 0.20, 0.24, 0.12)
      }
    }
  } catch {
    /* audio not available — ignore */
  }
}
