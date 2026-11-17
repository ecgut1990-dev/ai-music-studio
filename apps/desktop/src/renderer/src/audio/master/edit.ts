// Editing the song on the Mastering page: cut, copy, paste, delete, crop, silence, fades, gain, normalise, DC offset
// and trimming silence. The original file is never changed: the page keeps a list of these steps and applies them to
// the decoded original (undo = drop the last step). Pure functions on Float32Arrays, so they can be tested.
import { analyze } from './dsp'

export type FadeCurve = 'linear' | 'smooth' | 'log'

export type EditOp =
  | { type: 'delete'; start: number; end: number }                       // seconds; also "cut"
  | { type: 'crop'; start: number; end: number }                         // keep only this part
  | { type: 'paste'; at: number; clip: Float32Array[] }                  // insert audio at a position
  | { type: 'silence'; start: number; end: number }                      // make a part silent
  | { type: 'insertSilence'; at: number; seconds: number }
  | { type: 'fade'; start: number; end: number; dir: 'in' | 'out'; curve: FadeCurve }
  | { type: 'gain'; start: number; end: number; db: number }
  | { type: 'normalize'; start: number; end: number; mode: 'peak' | 'lufs'; target: number }
  | { type: 'dc' }
  | { type: 'trim'; thresholdDb: number }                                  // remove silence at the start and the end

export const OP_LABEL = (op: EditOp): string => {
  const t = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`
  switch (op.type) {
    case 'delete': return `Cut ${t(op.start)}–${t(op.end)}`
    case 'crop': return `Crop to ${t(op.start)}–${t(op.end)}`
    case 'paste': return `Paste ${(op.clip[0].length / 48000).toFixed(2)} s at ${t(op.at)}`
    case 'silence': return `Silence ${t(op.start)}–${t(op.end)}`
    case 'insertSilence': return `Insert ${op.seconds.toFixed(2)} s silence at ${t(op.at)}`
    case 'fade': return `Fade ${op.dir} ${t(op.start)}–${t(op.end)} (${op.curve})`
    case 'gain': return `Gain ${op.db > 0 ? '+' : ''}${op.db} dB ${t(op.start)}–${t(op.end)}`
    case 'normalize': return `Normalise to ${op.target} ${op.mode === 'peak' ? 'dBFS' : 'LUFS'}`
    case 'dc': return 'Remove DC offset'
    case 'trim': return 'Trim silence at start and end'
  }
}

type Chans = Float32Array[]

const idx = (sec: number, sr: number, n: number): number => Math.max(0, Math.min(n, Math.round(sec * sr)))

function concat(parts: Chans[]): Chans {
  const chs = parts[0].length
  const len = parts.reduce((s, p) => s + p[0].length, 0)
  const out = Array.from({ length: chs }, () => new Float32Array(len))
  let o = 0
  for (const p of parts) { for (let c = 0; c < chs; c++) out[c].set(p[c] ?? p[0], o); o += p[0].length }
  return out
}

const slice = (ch: Chans, a: number, b: number): Chans => ch.map((x) => x.slice(a, b))

/** The fade shape for a position 0 … 1 (fade in; a fade out uses 1 − t). */
export function fadeShape(t: number, curve: FadeCurve): number {
  if (curve === 'linear') return t
  if (curve === 'smooth') return 0.5 - 0.5 * Math.cos(Math.PI * t)          // S-curve
  return t <= 0 ? 0 : Math.pow(10, (t - 1) * 3)                               // log: like a volume knob, −60 dB at the start
}

/** One step applied to the audio; returns new arrays (the input is not changed). */
export function applyOp(ch: Chans, sr: number, op: EditOp): Chans {
  const n = ch[0].length
  switch (op.type) {
    case 'delete': {
      const a = idx(op.start, sr, n), b = idx(op.end, sr, n)
      return b > a ? concat([slice(ch, 0, a), slice(ch, b, n)]) : ch.map((x) => x.slice())
    }
    case 'crop': {
      const a = idx(op.start, sr, n), b = idx(op.end, sr, n)
      return b > a ? slice(ch, a, b) : ch.map((x) => x.slice())
    }
    case 'paste': {
      const a = idx(op.at, sr, n)
      return concat([slice(ch, 0, a), op.clip, slice(ch, a, n)])
    }
    case 'insertSilence': {
      const a = idx(op.at, sr, n), len = Math.max(0, Math.round(op.seconds * sr))
      return concat([slice(ch, 0, a), ch.map(() => new Float32Array(len)), slice(ch, a, n)])
    }
    case 'trim': {
      const thr = Math.pow(10, op.thresholdDb / 20)
      let a = 0, b = n
      const loud = (i: number): boolean => ch.some((x) => Math.abs(x[i]) > thr)
      while (a < n && !loud(a)) a++
      while (b > a && !loud(b - 1)) b--
      // keep a few milliseconds so the first transient is not clipped
      a = Math.max(0, a - Math.round(sr * 0.005)); b = Math.min(n, b + Math.round(sr * 0.05))
      return slice(ch, a, b)
    }
    default: {
      const out = ch.map((x) => x.slice())
      if (op.type === 'dc') {
        for (const x of out) { let m = 0; for (let i = 0; i < x.length; i++) m += x[i]; m /= Math.max(1, x.length); for (let i = 0; i < x.length; i++) x[i] -= m }
        return out
      }
      const a = idx(op.start, sr, n), b = idx(op.end, sr, n)
      if (b <= a) return out
      if (op.type === 'silence') { for (const x of out) x.fill(0, a, b); return out }
      if (op.type === 'gain') {
        const g = Math.pow(10, op.db / 20)
        for (const x of out) for (let i = a; i < b; i++) x[i] *= g
        return out
      }
      if (op.type === 'fade') {
        const len = b - a
        for (const x of out) for (let i = a; i < b; i++) {
          const t = (i - a) / Math.max(1, len - 1)
          x[i] *= fadeShape(op.dir === 'in' ? t : 1 - t, op.curve)
        }
        return out
      }
      // normalise the part (or the whole song) to a peak or a loudness
      const part = out.map((x) => x.subarray(a, b))
      let g = 1
      if (op.mode === 'peak') {
        let pk = 0
        for (const x of part) for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > pk) pk = v }
        if (pk > 0) g = Math.pow(10, op.target / 20) / pk
      } else {
        const l = analyze(part.length > 1 ? part : [part[0], part[0]], sr).integrated
        if (Number.isFinite(l)) g = Math.pow(10, (op.target - l) / 20)
      }
      for (const x of part) for (let i = 0; i < x.length; i++) x[i] *= g
      return out
    }
  }
}

/** All steps in order, on a copy of the original. */
export function applyEdits(original: Chans, sr: number, ops: EditOp[]): Chans {
  let ch = original
  for (const op of ops) ch = applyOp(ch, sr, op)
  return ch === original ? original.map((x) => x.slice()) : ch
}

/** The audio of a part (for copy / cut). */
export function copyPart(ch: Chans, sr: number, start: number, end: number): Chans {
  const n = ch[0].length
  return slice(ch, idx(start, sr, n), idx(end, sr, n))
}
