// Mastering assistant: measures a song (tone balance in eight bands, dynamics, stereo, loudness, clipping, silence)
// and proposes settings for the chain, each with a short reason. Rules on measurements, no AI model: it runs at once
// and offline. The tone balance is compared with a genre profile or with a reference song.
import { crossover, type Analysis } from './dsp'
import type { Chain, EqParams, Slot } from './chain'
import { slotDefaults } from './chain'
import type { EditOp } from './edit'

export const BANDS = [
  { id: 'sub', label: 'Sub bass', lo: 20, hi: 60 },
  { id: 'bass', label: 'Bass', lo: 60, hi: 150 },
  { id: 'lowmid', label: 'Low mids', lo: 150, hi: 400 },
  { id: 'mid', label: 'Mids', lo: 400, hi: 1000 },
  { id: 'upmid', label: 'Upper mids', lo: 1000, hi: 3000 },
  { id: 'presence', label: 'Presence', lo: 3000, hi: 6000 },
  { id: 'brilliance', label: 'Brilliance', lo: 6000, hi: 12000 },
  { id: 'air', label: 'Air', lo: 12000, hi: 20000 },
] as const
export type BandId = typeof BANDS[number]['id']

/** Energy per octave in each band, in dB relative to their average (a flat line = pink noise). */
export type Balance = Record<BandId, number>

export interface Profile {
  id: string
  label: string
  balance: Balance           // target tone balance (same scale as Balance)
  crest: [number, number]    // the crest factor range (dB) that suits the style
  lufs: number               // usual loudness
  target: string             // id in TARGETS
  monoBelow: number          // bass in mono below (Hz)
}

// Target balances: energy per octave relative to the mean, as measured on typical modern masters of each style
// (a falling line: music has less energy per octave in the highs than pink noise). Deliberately smooth; the
// assistant only acts on clear differences (more than 2 dB) and never by more than 4 dB at once.
const P = (sub: number, bass: number, lowmid: number, mid: number, upmid: number, presence: number, brilliance: number, air: number): Balance =>
  ({ sub, bass, lowmid, mid, upmid, presence, brilliance, air })
export const PROFILES: Profile[] = [
  { id: 'techno', label: 'Techno / House', balance: P(6, 7, 3, 0, -2, -3, -4, -7), crest: [7, 10], lufs: -9, target: 'loud', monoBelow: 150 },
  { id: 'afro', label: 'Afro House', balance: P(5, 7, 3, 0, -1, -3, -4, -7), crest: [7, 11], lufs: -9, target: 'loud', monoBelow: 140 },
  { id: 'trance', label: 'Trance / EDM', balance: P(5, 6, 2, 0, -1, -2, -3, -6), crest: [6, 9], lufs: -8, target: 'loud', monoBelow: 140 },
  { id: 'pop', label: 'Pop', balance: P(3, 5, 3, 1, 0, -2, -3, -6), crest: [8, 11], lufs: -11, target: 'streaming', monoBelow: 120 },
  { id: 'hiphop', label: 'Hip-hop', balance: P(7, 7, 3, 0, -2, -3, -4, -8), crest: [8, 11], lufs: -10, target: 'streaming', monoBelow: 140 },
  { id: 'rock', label: 'Rock', balance: P(1, 4, 4, 2, 1, -1, -3, -7), crest: [8, 12], lufs: -10, target: 'streaming', monoBelow: 110 },
  { id: 'soul', label: 'Soul / R&B', balance: P(3, 5, 4, 2, 0, -2, -4, -7), crest: [9, 13], lufs: -12, target: 'streaming', monoBelow: 120 },
  { id: 'funk', label: 'Funk', balance: P(2, 6, 3, 2, 1, -1, -3, -7), crest: [9, 13], lufs: -11, target: 'streaming', monoBelow: 120 },
  { id: 'acoustic', label: 'Acoustic / singer-songwriter', balance: P(-2, 3, 4, 2, 1, -1, -3, -6), crest: [11, 16], lufs: -14, target: 'streaming', monoBelow: 100 },
  { id: 'podcast', label: 'Podcast / speech', balance: P(-8, 0, 3, 4, 3, 1, -3, -9), crest: [10, 15], lufs: -16, target: 'podcast', monoBelow: 150 },
]

/** Tone balance of a song: band energies (Linkwitz-Riley splits of the mid signal), per octave, relative to the mean. */
export function measureBalance(ch: Float32Array[], sr: number): Balance {
  const n = ch[0].length
  const mid = new Float32Array(n)
  for (let i = 0; i < n; i++) mid[i] = (ch[0][i] + (ch[1] ?? ch[0])[i]) * 0.5
  const edges = BANDS.slice(1).map((b) => b.lo)                 // 60 150 400 1000 3000 6000 12000
  // split the signal step by step: low part of edge k = band k, the rest continues upwards
  const run = (x: Float32Array, c: number[]): Float32Array => {
    const y = new Float32Array(x.length)
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < x.length; i++) {
      const v = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v
    }
    return y
  }
  const energy: number[] = []
  const hp20 = crossover(sr, 20).high                            // nothing below 20 Hz counts as sub bass
  let rest = run(run(mid, hp20), hp20)
  for (const f of edges) {
    const xo = crossover(sr, f)
    const low = run(run(rest, xo.low), xo.low)
    rest = run(run(rest, xo.high), xo.high)
    let e = 0
    for (let i = 0; i < low.length; i++) e += low[i] * low[i]
    energy.push(e)
  }
  let e = 0
  for (let i = 0; i < rest.length; i++) e += rest[i] * rest[i]
  energy.push(e)
  // the top band reaches up to half the sample rate
  const octaves = (k: number): number => Math.log2((k === BANDS.length - 1 ? sr / 2 : BANDS[k].hi) / BANDS[k].lo)
  const perOct = energy.map((v, k) => 10 * Math.log10(Math.max(v, 1e-12) / octaves(k)))
  const mean = perOct.reduce((a, b) => a + b, 0) / perOct.length
  return Object.fromEntries(BANDS.map((b, k) => [b.id, Math.round((perOct[k] - mean) * 10) / 10])) as Balance
}

/** How much of the bass (below 150 Hz) is on the sides: 0 = mono bass, 1 = as much side as mid. */
export function bassWidth(ch: Float32Array[], sr: number): number {
  if (ch.length < 2) return 0
  const xo = crossover(sr, 150).low
  let m1 = 0, m2 = 0, n1 = 0, n2 = 0, s1 = 0, s2 = 0, t1 = 0, t2 = 0, em = 0, es = 0
  const L = ch[0], R = ch[1]
  for (let i = 0; i < L.length; i++) {
    const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5
    const ym = xo[0] * m + xo[1] * m1 + xo[2] * m2 - xo[3] * n1 - xo[4] * n2
    m2 = m1; m1 = m; n2 = n1; n1 = ym
    const ys = xo[0] * s + xo[1] * s1 + xo[2] * s2 - xo[3] * t1 - xo[4] * t2
    s2 = s1; s1 = s; t2 = t1; t1 = ys
    em += ym * ym; es += ys * ys
  }
  return em > 0 ? Math.sqrt(es / em) : 0
}

export interface Suggestion {
  id: string
  area: 'tone' | 'dynamics' | 'stereo' | 'loudness' | 'edit' | 'note'
  text: string                         // what it does and why, in one sentence
  apply?: (c: Chain) => Chain          // a change to the chain
  edit?: EditOp                        // a change to the file
  reach?: boolean                      // set the loudness target afterwards
  on: boolean                          // ticked by default
}

const eqOf = (c: Chain): Slot & { type: 'eq' } => (c.slots.find((s) => s.type === 'eq') as Slot & { type: 'eq' }) ?? (slotDefaults('eq', 'eq1') as Slot & { type: 'eq' })
const withEq = (c: Chain, f: (p: EqParams) => EqParams): Chain => {
  const has = c.slots.some((s) => s.type === 'eq')
  const eq = eqOf(c)
  const next = { ...eq, on: true, p: f(eq.p) } as Slot
  return { ...c, slots: has ? c.slots.map((s) => (s.type === 'eq' ? next : s)) : [next, ...c.slots] }
}
const withSlot = (c: Chain, type: Slot['type'], f: (s: Slot) => Slot): Chain => {
  const has = c.slots.some((s) => s.type === type)
  const base = (c.slots.find((s) => s.type === type) ?? slotDefaults(type, `${type}${Date.now().toString(36)}`)) as Slot
  const next = f({ ...base, on: true } as Slot)
  return { ...c, slots: has ? c.slots.map((s) => (s.type === type ? next : s)) : [...c.slots, next] }
}
const r1 = (v: number): number => Math.round(v * 2) / 2

/** The proposals for a song. `ref` (a reference song's balance) replaces the profile's balance when given. */
export function suggest(a: Analysis, bal: Balance, width: number, profile: Profile, ref?: Balance | null, silence?: { start: number; end: number }): Suggestion[] {
  const out: Suggestion[] = []
  const target = ref ?? profile.balance
  const diff = (b: BandId): number => bal[b] - target[b]
  const amount = (d: number): number => -Math.max(-4, Math.min(4, r1(d * 0.6)))    // move 60 % of the way, at most 4 dB
  const what = ref ? 'the reference' : profile.label
  const say = (b: BandId, d: number): string => `${BANDS.find((x) => x.id === b)!.label} ${d > 0 ? '+' : ''}${d.toFixed(1)} dB ${d > 0 ? 'above' : 'below'} ${what}`

  // tone: low end (shelf), boxiness (300 Hz), mids, harshness (dynamic EQ), air (shelf), rumble (low cut)
  const low = (diff('sub') + diff('bass')) / 2
  if (Math.abs(low) > 2) {
    const g = amount(low)
    out.push({ id: 'low', area: 'tone', on: true, text: `${say('bass', low)}: low shelf at 100 Hz ${g > 0 ? '+' : ''}${g} dB.`, apply: (c) => withEq(c, (p) => ({ ...p, lowF: 100, lowG: g })) })
  }
  if (diff('sub') > 4 && bal.sub > bal.bass) {
    out.push({ id: 'rumble', area: 'tone', on: true, text: `Much energy below 60 Hz (${diff('sub').toFixed(1)} dB above ${what}): low cut at 28 Hz removes rumble you cannot hear but that eats loudness.`, apply: (c) => withEq(c, (p) => ({ ...p, lowCut: 28 })) })
  }
  if (diff('lowmid') > 2) {
    const g = amount(diff('lowmid'))
    out.push({ id: 'box', area: 'tone', on: true, text: `${say('lowmid', diff('lowmid'))} (sounds muddy or boxy): band 1 at 300 Hz ${g} dB.`, apply: (c) => withEq(c, (p) => ({ ...p, p1F: 300, p1G: g, p1Q: 1.2 })) })
  }
  const mids = (diff('mid') + diff('upmid')) / 2
  if (Math.abs(mids) > 2) {
    const g = amount(mids)
    out.push({ id: 'mids', area: 'tone', on: true, text: `${say('mid', mids)}: band 2 at 1.2 kHz ${g > 0 ? '+' : ''}${g} dB.`, apply: (c) => withEq(c, (p) => ({ ...p, p2F: 1200, p2G: g, p2Q: 0.8 })) })
  }
  if (diff('presence') > 2) {
    const range = Math.min(6, r1(diff('presence')))
    out.push({ id: 'harsh', area: 'tone', on: true, text: `${say('presence', diff('presence'))} (can sound sharp): dynamic EQ at 3.5 kHz turns it down by up to ${range} dB only where it is loud.`, apply: (c) => withSlot(c, 'dyneq', (s) => ({ ...s, p: { ...(slotDefaults('dyneq', s.id).p), freq: 3500, q: 1.2, thresholdDb: -30, ratio: 3, rangeDb: range } } as Slot)) })
  } else if (diff('presence') < -2) {
    const g = amount(diff('presence'))
    out.push({ id: 'presence', area: 'tone', on: true, text: `${say('presence', diff('presence'))} (voice and snare lack presence): band 3 at 4 kHz +${g} dB.`, apply: (c) => withEq(c, (p) => ({ ...p, p3F: 4000, p3G: g, p3Q: 1 })) })
  }
  const highs = (diff('brilliance') + diff('air')) / 2
  if (Math.abs(highs) > 2) {
    const g = amount(highs)
    out.push({ id: 'air', area: 'tone', on: true, text: `${say('air', highs)}: high shelf at 10 kHz ${g > 0 ? '+' : ''}${g} dB.`, apply: (c) => withEq(c, (p) => ({ ...p, highF: 10000, highG: g })) })
  }
  if (highs < -4) {
    out.push({ id: 'excite', area: 'tone', on: false, text: 'The highs are very dull: a little exciter above 7 kHz adds air that a shelf alone cannot (try it, judge by ear).', apply: (c) => withSlot(c, 'saturation', (s) => ({ ...s, p: { ...(slotDefaults('saturation', s.id).p), mix: 0, driveDb: 0, exciteFreq: 7000, excite: 0.25 } } as Slot)) })
  }

  // dynamics
  const [lo, hi] = profile.crest
  if (a.crest > hi + 1) {
    const th = r1(Math.max(-40, Math.min(-6, a.rms + 6)))
    out.push({ id: 'glue', area: 'dynamics', on: true, text: `Very dynamic (crest factor ${a.crest.toFixed(1)} dB, ${profile.label} usually ${lo}–${hi}): compressor 2:1 from ${th} dB, slow attack, holds the mix together.`, apply: (c) => withSlot(c, 'comp', (s) => ({ ...s, p: { thresholdDb: th, ratio: 2, attackMs: 30, releaseMs: 200, kneeDb: 6, makeupDb: 0 } } as Slot)) })
  } else if (a.crest < lo - 1) {
    out.push({ id: 'squashed', area: 'dynamics', on: true, text: `Already strongly compressed (crest factor ${a.crest.toFixed(1)} dB): the compressor is switched off so the song keeps its punch.`, apply: (c) => ({ ...c, slots: c.slots.map((s) => (s.type === 'comp' || s.type === 'multiband' ? { ...s, on: false } : s)) as Slot[] }) })
  }

  // stereo
  if (width > 0.35) {
    out.push({ id: 'monobass', area: 'stereo', on: true, text: `The bass is wide (side signal ${Math.round(width * 100)} % of the middle below 150 Hz): mono below ${profile.monoBelow} Hz gives a tighter low end that works on club systems and phones.`, apply: (c) => withSlot(c, 'stereo', (s) => ({ ...s, p: { ...(s.p as object), width: (s.p as { width?: number }).width ?? 1, balance: (s.p as { balance?: number }).balance ?? 0, monoBelow: profile.monoBelow } } as Slot)) })
  }
  if (a.correlation < 0.2) {
    out.push({ id: 'phase', area: 'stereo', on: true, text: `The stereo correlation is low (${a.correlation.toFixed(2)}): parts may cancel in mono. Width 85 % makes it safer.`, apply: (c) => withSlot(c, 'stereo', (s) => ({ ...s, p: { ...(s.p as object), width: 0.85 } } as Slot)) })
  }

  // file
  if (a.clips.length > 0) out.push({ id: 'clips', area: 'note', on: false, text: `The original already reaches 0 dBFS in ${a.clips.length} places: that distortion is in the file and cannot be removed here. If you can, export the mix 1–3 dB quieter.` })
  if (silence && (silence.start > 0.3 || silence.end > 1)) {
    out.push({ id: 'trim', area: 'edit', on: true, text: `Silence at the start (${silence.start.toFixed(1)} s) or end (${silence.end.toFixed(1)} s): trim it.`, edit: { type: 'trim', thresholdDb: -60 } })
  }

  // loudness last
  out.push({ id: 'loud', area: 'loudness', on: true, reach: true, text: `Loudness: ${profile.label} is usually around ${profile.lufs} LUFS; the target is set and "Louder" is adjusted to reach it (true peak stays below the ceiling).` })
  return out
}

/** Seconds of near-silence at the start and the end. */
export function silenceAtEdges(ch: Float32Array[], sr: number, thresholdDb = -60): { start: number; end: number } {
  const thr = Math.pow(10, thresholdDb / 20), n = ch[0].length
  const loud = (i: number): boolean => ch.some((x) => Math.abs(x[i]) > thr)
  let a = 0, b = n
  while (a < n && !loud(a)) a++
  while (b > a && !loud(b - 1)) b--
  return { start: a / sr, end: (n - b) / sr }
}
