// Tiny Web Audio alerts — no audio files needed (works fully offline).
//
// Browser autoplay policy: an AudioContext created without a user gesture starts
// in the "suspended" state, and any oscillator scheduled on it is silent. Status
// changes arrive over the WebSocket with no user interaction, so we must (a) share
// a single context, and (b) resume it on the first real user gesture. After the
// first click/keypress every later alert is audible.

let ctx: AudioContext | null = null
let gestureHooked = false

// ── Sound on/off, persisted in localStorage (default ON) ───────────────────
const LS_KEY = 'nm.soundEnabled'
let soundEnabled = readEnabled()

function readEnabled(): boolean {
  try {
    return localStorage.getItem(LS_KEY) !== '0'   // anything but explicit "0" → ON
  } catch {
    return true
  }
}

export function isSoundEnabled(): boolean {
  return soundEnabled
}

export function setSoundEnabled(on: boolean): void {
  soundEnabled = on
  try {
    localStorage.setItem(LS_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable — keep in-memory state */
  }
  // A toggle IS a user gesture, so this is a good moment to unlock audio.
  if (on) void ensureCtx()?.resume()
}

/** Lazily create the one shared AudioContext and wire up the gesture unlock. */
function ensureCtx(): AudioContext | null {
  if (!ctx) {
    const Ctor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
  }
  hookGestureResume()
  return ctx
}

/** One-time document listener: resume the context on the first user gesture. */
function hookGestureResume(): void {
  if (gestureHooked) return
  gestureHooked = true
  const resume = () => {
    if (ctx && ctx.state === 'suspended') void ctx.resume()
    // Keep listening — some browsers re-suspend on tab blur, so re-arm cheaply.
  }
  document.addEventListener('pointerdown', resume)
  document.addEventListener('keydown', resume)
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

/** Short confirmation beep — used by the header 🔔 toggle so the user can
 * instantly HEAR that audio works (the toggle click also unlocks the context). */
export function playTestBeep(): void {
  try {
    const a = ensureCtx()
    if (!a) return
    if (a.state === 'suspended') void a.resume()
    tone(a, 660, 0, 0.12, 0.18)
    tone(a, 880, 0.14, 0.16, 0.18)
  } catch {
    /* ignore */
  }
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
 *
 * No-ops when sound is toggled off. If the context is still suspended (user has
 * not interacted yet) the notes are scheduled but silent — never throws.
 */
export function playAlert(kind: AlertKind): void {
  if (!soundEnabled) return
  try {
    const a = ensureCtx()
    if (!a) return
    // Resume if we can; if it's still suspended (no gesture yet) we schedule
    // anyway so nothing throws — the first post-gesture alert will be audible.
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
