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

// Master output: a compressor lets us push per-voice gains close to 1.0 for a
// LOUD alarm without hard digital clipping.
let master: DynamicsCompressorNode | null = null
function masterOut(a: AudioContext): AudioNode {
  if (!master) {
    master = a.createDynamicsCompressor()
    master.threshold.value = -12
    master.knee.value = 6
    master.ratio.value = 8
    master.attack.value = 0.003
    master.release.value = 0.2
    master.connect(a.destination)
  }
  return master
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
  gain.connect(masterOut(a))
  osc.start(t0 + start)
  osc.stop(t0 + start + dur + 0.02)
}

/**
 * Air-raid style siren: one continuous voice whose frequency WAILS up and down
 * (fLow→fHigh→fLow per cycle). Two slightly detuned oscillators thicken the
 * sound so it cuts through like a real civil-defence siren.
 */
function siren(
  a: AudioContext,
  fLow: number,
  fHigh: number,
  cycles: number,
  cycleDur: number,
  gainV: number,
  type: OscillatorType = 'sawtooth',
) {
  const t0 = a.currentTime
  const total = cycles * cycleDur
  const out = a.createGain()
  out.gain.setValueAtTime(0.0001, t0)
  out.gain.linearRampToValueAtTime(gainV, t0 + 0.08)
  out.gain.setValueAtTime(gainV, t0 + total - 0.4)
  out.gain.exponentialRampToValueAtTime(0.0001, t0 + total)
  out.connect(masterOut(a))

  for (const detune of [0, 8]) {
    const osc = a.createOscillator()
    osc.type = type
    osc.detune.value = detune
    osc.frequency.setValueAtTime(fLow, t0)
    for (let i = 0; i < cycles; i++) {
      const c = t0 + i * cycleDur
      osc.frequency.linearRampToValueAtTime(fHigh, c + cycleDur * 0.5)
      osc.frequency.linearRampToValueAtTime(fLow, c + cycleDur)
    }
    osc.connect(out)
    osc.start(t0)
    osc.stop(t0 + total + 0.05)
  }
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

/**
 * Play a status alert — LOUD, air-raid style (per user request: "come as if
 * the city is being bombed").
 *  - `critical` → ~10s civil-defence WAIL siren (sawtooth sweep 500→1100 Hz)
 *                 with a pounding low klaxon underneath — impossible to miss
 *  - `down`     → ~8s two-tone klaxon (à la submarine dive horn), loud
 *  - `up`       → ascending recovery chime, clearly audible but friendly
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
      // Air-raid wail: 5 sweep cycles × 2s = 10s, thick sawtooth, near-full gain.
      siren(a, 500, 1100, 5, 2.0, 0.9, 'sawtooth')
      // Pounding low klaxon bursts underneath for physical weight.
      for (let i = 0; i < 20; i++) {
        tone(a, 220, i * 0.5, 0.22, 0.5, 'square')
      }
    } else if (kind === 'down') {
      // Two-tone klaxon (AHOO-GA style): alternating long loud blasts, ~8s.
      const cycle = 0.8
      for (let i = 0; i < 10; i++) {
        tone(a, 650, i * cycle, 0.38, 0.75, 'square')
        tone(a, 420, i * cycle + 0.4, 0.38, 0.75, 'square')
      }
      // Short wail tail to make it unmistakably an alarm.
      siren(a, 400, 800, 2, 1.2, 0.55)
    } else {
      // Recovery: pleasant ascending chime, louder than before but not scary.
      const cycle = 0.7
      for (let i = 0; i < 8; i++) {
        tone(a, 523, i * cycle, 0.18, 0.3)
        tone(a, 784, i * cycle + 0.2, 0.24, 0.3)
        tone(a, 1046, i * cycle + 0.42, 0.2, 0.22)
      }
    }
  } catch {
    /* audio not available — ignore */
  }
}
