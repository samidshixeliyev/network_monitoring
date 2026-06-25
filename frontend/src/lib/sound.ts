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

/**
 * Play a status alert.
 *  - `critical` → loud, urgent repeating siren (high-priority, for important devices)
 *  - `down`     → standard two-tone alert
 *  - `up`       → soft confirmation
 */
export function playAlert(kind: AlertKind): void {
  try {
    const a = audioCtx()
    if (a.state === 'suspended') void a.resume()

    if (kind === 'critical') {
      // Urgent square-wave siren: 5 fast alternating high tones, louder.
      const seq = [1046, 784, 1046, 784, 1046]
      seq.forEach((f, i) => tone(a, f, i * 0.16, 0.14, 0.32, 'square'))
    } else if (kind === 'down') {
      tone(a, 880, 0, 0.18, 0.18)
      tone(a, 440, 0.22, 0.34, 0.18)
    } else {
      tone(a, 660, 0, 0.16, 0.12)
    }
  } catch {
    /* audio not available — ignore */
  }
}
