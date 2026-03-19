import { useState, useEffect, useCallback, useRef } from 'react'
import { createWorker } from 'tesseract.js'
import { supabase } from './supabaseClient'

// ─── Constants ────────────────────────────────────────────────────────────────

const SEASON_END = new Date('2026-03-25T05:59:00Z')
const SEASON_TOKENS = ['b2a', 'b2', 'season 11', 'season11', 'season records', 'ranked']

// Showcase cards seeded from known IDs — API fetch replaces with 5 ex cards if reachable

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPoints(n) { return Number(n).toLocaleString() }

function formatDateTime(d) {
  if (!d) return ''
  const date = new Date(d)
  const datePart = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  const timePart = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `${datePart}, ${timePart} (${tz})`
}

function getPrediction(entries) {
  if (entries.length < 2) return null
  const sorted = [...entries].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const xs = sorted.map(e => new Date(e.created_at).getTime())
  const ys = sorted.map(e => Number(e.points))
  const n = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  const num = xs.reduce((acc, x, i) => acc + (x - meanX) * (ys[i] - meanY), 0)
  const den = xs.reduce((acc, x) => acc + (x - meanX) ** 2, 0)
  if (den === 0) return null
  const slope = num / den
  const intercept = meanY - slope * meanX
  const now = new Date()
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
  const predicted = Math.round(slope * endOfMonth.getTime() + intercept)
  const ssTot = ys.reduce((acc, y) => acc + (y - meanY) ** 2, 0)
  const ssRes = ys.reduce((acc, y, i) => acc + (y - (slope * xs[i] + intercept)) ** 2, 0)
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot
  const trend = slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'stable'
  return { predicted, trend, r2: Math.max(0, r2), endOfMonth }
}

// Parse username, rank, and points from the Season Records screen.
// The player's own card is always pinned at the top.
// Tesseract reads the card right-to-left (name before rank badge), so we use
// two independent passes rather than assuming a fixed token order.
function parseSeasonCard(text) {
  const UI_SKIP = /^(season|records|refresh|rankings|list|win|rate|wins|losses|last|refreshed|ranked|match|battle|unranked|master|ball|a2b|b2a|b2|b1|streak|at|pm|am|ex)$/i

  // First "X pts" occurrence = the player's own card (always at top)
  const ptsMatch = text.match(/([0-9][0-9,]+)\s*pts/i)
  if (!ptsMatch) return { rank: null, username: null, points: null }

  const points = parseInt(ptsMatch[1].replace(/,/g, ''), 10)
  const textBefore = text.slice(0, ptsMatch.index)
  const tokens = textBefore.split(/[\s\n\r]+/).filter(t => t.length >= 1)

  // Unranked: rank badge shows "-" alone on its own line
  const isUnranked = /^\s*[-–—]\s*$/m.test(textBefore)

  // Pass 1: username — last non-numeric, non-UI, non-dash token of 2+ chars before pts
  // Requiring length >= 2 filters out single-char OCR artifacts (e.g. "H" from avatar borders)
  let username = null
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (t.length >= 2 && !/^[\d,%.]+$/.test(t) && !UI_SKIP.test(t) && !/^[-–—]+$/.test(t)) { username = t; break }
  }

  if (isUnranked) return { rank: null, username, points, isUnranked: true }

  // Pass 2: rank — prefer a number alone on its own line (the rank badge).
  // Search only after "Season Records" header to skip the status bar (battery %, time, signal).
  let rank = null
  const seasonIdx = textBefore.search(/season\s*records/i)
  const rankSearchRegion = seasonIdx !== -1
    ? textBefore.slice(seasonIdx)
    : textBefore.split('\n').slice(1).join('\n') // fallback: skip first line (status bar)
  const standaloneMatch = rankSearchRegion.match(/^\s*([0-9][0-9,]*)\s*$/m)
  if (standaloneMatch) {
    const n = parseInt(standaloneMatch[1].replace(/,/g, ''), 10)
    if (n >= 1 && n <= 10000) rank = n
  }

  // Fallback: last number in range 1–10,000 across all tokens
  if (!rank) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i]
      if (/^[\d,]+$/.test(t)) {
        const n = parseInt(t.replace(/,/g, ''), 10)
        if (n >= 1 && n <= 10000) { rank = n; break }
      }
    }
  }

  // Fallback: # pattern (older screen formats)
  if (!rank) {
    const hashMatch = text.match(/#\s*([0-9][0-9,]*)/)
    if (hashMatch) {
      const n = parseInt(hashMatch[1].replace(/,/g, ''), 10)
      if (n >= 1 && n <= 10000) rank = n
    }
  }

  return { rank, username, points }
}

function ocrContainsSeason(text) {
  const lower = text.toLowerCase()
  return SEASON_TOKENS.some(token => lower.includes(token))
}

// Flag submissions whose points are >3 standard deviations from the community mean
function isOutlier(points, entries) {
  if (entries.length < 5) return false
  const pts = entries.map(e => Number(e.points))
  const mean = pts.reduce((a, b) => a + b, 0) / pts.length
  const std = Math.sqrt(pts.reduce((acc, p) => acc + (p - mean) ** 2, 0) / pts.length)
  return std > 0 && Math.abs(points - mean) > 3 * std
}

// Try to read EXIF DateTimeOriginal from a photo file (works for JPEG, not PNG)
async function getExifDate(file) {
  try {
    const exifr = (await import('exifr')).default
    const data = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate', 'DateTime'])
    const dt = data?.DateTimeOriginal || data?.CreateDate || data?.DateTime
    if (dt instanceof Date && !isNaN(dt)) return dt
    return null
  } catch {
    return null
  }
}

// ─── useCountdown ─────────────────────────────────────────────────────────────

function useCountdown(target) {
  const [timeLeft, setTimeLeft] = useState(() => Math.max(0, target - Date.now()))
  useEffect(() => {
    const id = setInterval(() => setTimeLeft(Math.max(0, target - Date.now())), 1000)
    return () => clearInterval(id)
  }, [target])
  const days    = Math.floor(timeLeft / 86400000)
  const hours   = Math.floor((timeLeft % 86400000) / 3600000)
  const minutes = Math.floor((timeLeft % 3600000) / 60000)
  const seconds = Math.floor((timeLeft % 60000) / 1000)
  return { days, hours, minutes, seconds, ended: timeLeft === 0 }
}

// ─── SeasonTimer ──────────────────────────────────────────────────────────────

function SeasonTimer() {
  const { days, hours, minutes, seconds, ended } = useCountdown(SEASON_END.getTime())
  const urgent = !ended && days === 0 && hours < 6

  if (ended) {
    return (
      <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 14, padding: '14px 20px', marginBottom: 24, textAlign: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#f87171', fontFamily: 'Rajdhani, sans-serif', letterSpacing: 1, textTransform: 'uppercase' }}>🏁 Season 11 has ended</span>
      </div>
    )
  }

  const block = (val, label) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 48 }}>
      <span style={{ fontSize: 'clamp(1.4rem, 4vw, 2rem)', fontWeight: 900, fontFamily: 'Rajdhani, sans-serif', color: urgent ? '#f87171' : '#c4b5fd', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {String(val).padStart(2, '0')}
      </span>
      <span style={{ fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: urgent ? '#f87171' : '#6C63FF', marginTop: 2, fontFamily: 'Rajdhani, sans-serif', fontWeight: 700 }}>{label}</span>
    </div>
  )

  const sep = <span style={{ fontSize: 'clamp(1.2rem, 3vw, 1.7rem)', fontWeight: 900, color: urgent ? 'rgba(248,113,113,0.5)' : 'rgba(108,99,255,0.4)', alignSelf: 'flex-start', marginTop: 2, fontFamily: 'Rajdhani, sans-serif' }}>:</span>

  return (
    <div style={{ background: urgent ? 'rgba(239,68,68,0.07)' : 'rgba(108,99,255,0.07)', border: `1px solid ${urgent ? 'rgba(239,68,68,0.3)' : 'rgba(108,99,255,0.25)'}`, borderRadius: 14, padding: '14px 20px', marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
      <div>
        <div style={{ fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase', color: urgent ? '#f87171' : '#6C63FF', fontWeight: 700, fontFamily: 'Rajdhani, sans-serif', marginBottom: 2 }}>
          {urgent ? '⚠️ ' : ''}Season 11 (B2a) ends
        </div>
        <div style={{ fontSize: 11, color: urgent ? '#f87171' : '#7c6fa0' }}>
          {SEASON_END.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · {SEASON_END.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {days > 0 && <>{block(days, 'days')}{sep}</>}
        {block(hours, 'hrs')}{sep}
        {block(minutes, 'min')}{sep}
        {block(seconds, 'sec')}
      </div>
    </div>
  )
}


// ─── AdUnit ───────────────────────────────────────────────────────────────────

function AdUnit({ slot, format = 'auto' }) {
  useEffect(() => {
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}) } catch {}
  }, [])
  return (
    <ins
      className="adsbygoogle"
      style={{ display: 'block' }}
      data-ad-client="ca-pub-6555139524342540"
      data-ad-slot={slot}
      data-ad-format={format}
      data-full-width-responsive="true"
    />
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Lightbox({ url, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, cursor: 'zoom-out', animation: 'fadeIn 0.2s ease' }}>
      <div onClick={e => e.stopPropagation()} style={{ position: 'relative', maxWidth: '90vw', maxHeight: '90vh' }}>
        <img src={url} alt="Proof screenshot" style={{ maxWidth: '100%', maxHeight: '85vh', borderRadius: 16, border: '2px solid rgba(108,99,255,0.4)', boxShadow: '0 24px 80px rgba(0,0,0,0.8)', display: 'block' }} />
        <button onClick={onClose} style={{ position: 'absolute', top: -14, right: -14, background: '#6C63FF', border: 'none', borderRadius: '50%', width: 32, height: 32, color: '#fff', cursor: 'pointer', fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}>✕</button>
      </div>
    </div>
  )
}

function OcrStatus({ status, message }) {
  const configs = {
    idle:     { color: '#4a4070', bg: 'transparent',           border: 'transparent',          icon: null },
    scanning: { color: '#a78bfa', bg: 'rgba(108,99,255,0.08)', border: 'rgba(108,99,255,0.2)', icon: '🔍' },
    pass:     { color: '#34d399', bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.3)', icon: '✅' },
    fail:     { color: '#f87171', bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.3)',  icon: '❌' },
    warn:     { color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.3)', icon: '⚠️' },
  }
  const c = configs[status] || configs.idle
  if (status === 'idle') return null
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', borderRadius: 10, background: c.bg, border: `1px solid ${c.border}`, fontSize: 13, color: c.color, transition: 'all 0.3s' }}>
      {c.icon && <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }}>{c.icon}</span>}
      <span>{message}</span>
    </div>
  )
}

function ScreenshotUpload({ file, preview, onFile, onClear }) {
  const inputRef = useRef()
  const [dragging, setDragging] = useState(false)

  function handleDrop(e) { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f) }
  function handleChange(e) { const f = e.target.files?.[0]; if (f) onFile(f) }

  if (preview) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: '#6C63FF', fontWeight: 700, fontFamily: 'Rajdhani, sans-serif' }}>Screenshot</label>
        <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(52,211,153,0.4)', background: 'rgba(52,211,153,0.05)' }}>
          <img src={preview} alt="Preview" style={{ width: '100%', maxHeight: 160, objectFit: 'cover', display: 'block' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,0.65) 0%, transparent 50%)', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', padding: '10px 12px' }}>
            <span style={{ fontSize: 12, color: '#34d399', fontWeight: 700 }}>✓ {file.name}</span>
            <button onClick={onClear} style={{ background: 'rgba(239,68,68,0.7)', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 11, padding: '3px 8px', fontFamily: 'inherit', fontWeight: 700 }}>Remove</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: '#6C63FF', fontWeight: 700, fontFamily: 'Rajdhani, sans-serif' }}>
        Screenshot <span style={{ color: '#4a4070', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>(required)</span>
      </label>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        style={{ border: `2px dashed ${dragging ? 'rgba(108,99,255,0.8)' : 'rgba(108,99,255,0.3)'}`, borderRadius: 10, padding: '28px 20px', background: dragging ? 'rgba(108,99,255,0.08)' : 'rgba(255,255,255,0.02)', textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s' }}
      >
        <div style={{ fontSize: 28, marginBottom: 8 }}>📸</div>
        <div style={{ fontSize: 14, color: '#a78bfa', fontWeight: 600 }}>Drop your screenshot here</div>
        <div style={{ fontSize: 12, color: '#4a4070', marginTop: 4 }}>or click to browse · PNG, JPG, WebP · max 5MB</div>
        <div style={{ fontSize: 11, color: '#3a305a', marginTop: 8 }}>Points and rank will be read automatically</div>
      </div>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleChange} style={{ display: 'none' }} />
    </div>
  )
}


// ─── LoginView ────────────────────────────────────────────────────────────────

function LoginView() {
  const [loading, setLoading] = useState(null)
  const [error, setError] = useState('')

  async function signIn(provider) {
    setLoading(provider)
    setError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    })
    if (error) { setError(error.message); setLoading(null) }
  }

  const providers = [
    { id: 'google', label: 'Continue with Google', bg: '#fff', color: '#3c4043', border: '1px solid rgba(0,0,0,0.12)' },
  ]

  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(108,99,255,0.2)', borderRadius: 18, padding: '40px 28px', backdropFilter: 'blur(10px)', textAlign: 'center', animation: 'fadeSlideIn 0.35s ease' }}>
      <div style={{ fontSize: 44, marginBottom: 12 }}>🔐</div>
      <h2 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 800, color: '#c4b5fd', fontFamily: 'Rajdhani, sans-serif' }}>Sign In to Submit</h2>
      <p style={{ margin: '0 0 28px', fontSize: 13, color: '#7c6fa0', lineHeight: 1.6 }}>
        Sign in with Google to submit snapshots.<br />
        <span style={{ color: '#4a4070' }}>The leaderboard is public — no sign-in needed to view.</span>
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 300, margin: '0 auto' }}>
        {providers.map(p => (
          <button
            key={p.id}
            onClick={() => signIn(p.id)}
            disabled={!!loading}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '13px 20px', borderRadius: 12, border: p.border, background: loading === p.id ? 'rgba(108,99,255,0.3)' : p.bg, color: loading === p.id ? '#a78bfa' : p.color, cursor: loading ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700, fontFamily: 'DM Sans, sans-serif', opacity: loading && loading !== p.id ? 0.45 : 1, transition: 'all 0.15s' }}
          >
            {loading === p.id ? 'Redirecting…' : p.label}
          </button>
        ))}
      </div>
      {error && <div style={{ marginTop: 16, color: '#f87171', fontSize: 13 }}>⚠️ {error}</div>}
    </div>
  )
}

// ─── ProfileSetup ─────────────────────────────────────────────────────────────

function ProfileSetup({ onComplete }) {
  const [username, setUsername] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave(e) {
    e.preventDefault()
    if (!username.trim()) return setError('Please enter your in-game username.')
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ data: { ptcg_username: username.trim() } })
    setSaving(false)
    if (error) return setError(error.message)
    onComplete(username.trim())
  }

  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(108,99,255,0.2)', borderRadius: 18, padding: '40px 28px', backdropFilter: 'blur(10px)', textAlign: 'center', animation: 'fadeSlideIn 0.35s ease' }}>
      <div style={{ fontSize: 44, marginBottom: 12 }}>🎮</div>
      <h2 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 800, color: '#c4b5fd', fontFamily: 'Rajdhani, sans-serif' }}>Set Your In-Game Name</h2>
      <p style={{ margin: '0 0 24px', fontSize: 13, color: '#7c6fa0' }}>
        Enter your Pokémon TCG Pocket trainer name — this is what will appear on the leaderboard.
      </p>
      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 300, margin: '0 auto' }}>
        <input
          value={username}
          onChange={e => { setUsername(e.target.value); setError('') }}
          placeholder="YourTrainerName"
          autoFocus
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(108,99,255,0.25)', borderRadius: 10, padding: '12px 14px', color: '#e8e0ff', fontFamily: 'DM Sans, sans-serif', fontSize: 15, outline: 'none', colorScheme: 'dark', textAlign: 'center' }}
        />
        {error && <div style={{ color: '#f87171', fontSize: 12 }}>{error}</div>}
        <button type="submit" disabled={saving} style={{ padding: '13px 0', borderRadius: 12, border: 'none', cursor: saving ? 'not-allowed' : 'pointer', background: 'linear-gradient(135deg, #6C63FF 0%, #8b5cf6 50%, #38bdf8 100%)', color: '#fff', fontFamily: 'Rajdhani, sans-serif', fontWeight: 800, fontSize: 17, opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Saving…' : 'Save & Continue ✦'}
        </button>
      </form>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  // ── Auth state ──
  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [ptcgUsername, setPtcgUsername] = useState('')

  // ── App state ──
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
  const [dbError, setDbError] = useState('')
  const [tab, setTab] = useState('submit')
  const [animIn, setAnimIn] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState(null)

  // ── Screenshot + OCR state ──
  const [screenshotFile, setScreenshotFile] = useState(null)
  const [screenshotPreview, setScreenshotPreview] = useState(null)
  const [ocrStatus, setOcrStatus] = useState('idle')
  const [ocrMessage, setOcrMessage] = useState('')
  const [ocrPassed, setOcrPassed] = useState(false)
  const [ocrExtracted, setOcrExtracted] = useState({ points: null, rank: null, username: null })
  const [exifDate, setExifDate] = useState(null)
  const ocrAbortRef = useRef(false)

  // ── Auth: listen for session changes ──
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setPtcgUsername(session?.user?.user_metadata?.ptcg_username || '')
      setAuthLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setPtcgUsername(session?.user?.user_metadata?.ptcg_username || '')
    })
    return () => subscription.unsubscribe()
  }, [])

  // ── Fetch entries ──
  const fetchEntries = useCallback(async () => {
    setLoading(true); setDbError('')
    const { data, error } = await supabase.from('cutoff_entries').select('*').order('created_at', { ascending: false })
    if (error) { setDbError('Could not load data. Check your Supabase config.'); console.error(error) }
    else setEntries(data || [])
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchEntries()
    setTimeout(() => setAnimIn(true), 60)
    const hourly = setInterval(fetchEntries, 60 * 60 * 1000)
    return () => clearInterval(hourly)
  }, [fetchEntries])

  useEffect(() => {
    const channel = supabase.channel('cutoff_entries_changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'cutoff_entries' }, payload => setEntries(prev => [payload.new, ...prev]))
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  // ── OCR: parse Season Records screenshot and verify against profile + community data ──
  async function runOcr(file) {
    ocrAbortRef.current = false
    setOcrStatus('scanning')
    setOcrMessage('Scanning your screenshot…')
    setOcrPassed(false)
    setOcrExtracted({ points: null, rank: null, username: null })

    try {
      const worker = await createWorker('eng', 1, { logger: () => {} })
      if (ocrAbortRef.current) { await worker.terminate(); return }

      const { data: { text } } = await worker.recognize(file)
      await worker.terminate()
      if (ocrAbortRef.current) return

      console.log('=== RAW OCR TEXT ===')
      console.log(text)
      console.log('=== END OCR TEXT ===')

      const { rank, username, points, isUnranked } = parseSeasonCard(text)
      const foundSeason = ocrContainsSeason(text)

      // Unranked: dash in rank badge position, explicit "Unranked" text, or points+username readable but no rank
      if (isUnranked || /unranked/i.test(text) || (!rank && points && username)) {
        setOcrStatus('fail')
        setOcrMessage(`${username ? `"${username}" is` : 'This account is'} not in the top 10,000 this season — only ranked players can submit.`)
        setOcrPassed(false)
        return
      }

      // All three values must be readable
      if (!points || !rank || !username) {
        const missing = [!points && 'points', !rank && 'rank', !username && 'username'].filter(Boolean)
        setOcrStatus('fail')
        setOcrMessage(`Couldn't read ${missing.join(', ')} from your screenshot. Make sure you're uploading the Season Records screen with your rank visible.`)
        setOcrPassed(false)
        return
      }

      // Username must match the registered profile name
      if (username.toLowerCase() !== ptcgUsername.toLowerCase()) {
        setOcrStatus('fail')
        setOcrMessage(`Username mismatch: screenshot shows "${username}" but your profile is "${ptcgUsername}". Submit your own Season Records screenshot.`)
        setOcrPassed(false)
        return
      }

      // Flag points wildly outside community range
      if (isOutlier(points, entries)) {
        setOcrStatus('fail')
        setOcrMessage(`${formatPoints(points)} pts is far outside the range of recent community submissions. Make sure this screenshot is from the current season.`)
        setOcrPassed(false)
        return
      }

      setOcrExtracted({ points, rank, username })
      setOcrStatus(foundSeason ? 'pass' : 'warn')
      setOcrMessage(
        foundSeason
          ? `Verified: ${username} · #${rank.toLocaleString()} · ${formatPoints(points)} pts`
          : `Detected: ${username} · #${rank.toLocaleString()} · ${formatPoints(points)} pts — ⚠️ Season not confirmed, make sure this is from the current season.`
      )
      setOcrPassed(true)
    } catch (err) {
      console.error('OCR error:', err)
      setOcrStatus('fail')
      setOcrMessage("Couldn't scan the screenshot. Try a clearer image of the Season Records screen.")
      setOcrPassed(false)
    }
  }

  // ── Screenshot handlers ──
  async function handleScreenshotFile(f) {
    if (f.size > 5 * 1024 * 1024) { setError('Screenshot must be under 5MB.'); return }
    setScreenshotFile(f)
    setScreenshotPreview(URL.createObjectURL(f))
    setError('')
    setExifDate(null)

    // Try EXIF timestamp (works for JPEG photos, usually not PNG)
    const exif = await getExifDate(f)
    if (exif) setExifDate(exif)

    runOcr(f)
  }

  function clearScreenshot() {
    ocrAbortRef.current = true
    setScreenshotFile(null)
    if (screenshotPreview) URL.revokeObjectURL(screenshotPreview)
    setScreenshotPreview(null)
    setOcrStatus('idle'); setOcrMessage(''); setOcrPassed(false)
    setOcrExtracted({ points: null, rank: null, username: null })
    setExifDate(null)
  }

  // ── Submit ──
  async function handleSubmit(e) {
    e.preventDefault()
    if (!screenshotFile) return setError('Please upload a screenshot.')
    if (ocrStatus === 'scanning') return setError('Please wait — still scanning…')
    if (!ocrPassed || !ocrExtracted.points || !ocrExtracted.rank) return setError('Screenshot could not be verified. Please try again with a clearer Season Records screenshot.')
    const pts = ocrExtracted.points
    const rank = ocrExtracted.rank

    setSubmitting(true)

    const ext = screenshotFile.name.split('.').pop()
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error: uploadError } = await supabase.storage.from('screenshots').upload(filename, screenshotFile, { contentType: screenshotFile.type, upsert: false })
    if (uploadError) { setSubmitting(false); setError('Screenshot upload failed.'); console.error(uploadError); return }

    const { data: urlData } = supabase.storage.from('screenshots').getPublicUrl(filename)

    // Use EXIF date if available (when screenshot was actually taken), else today
    const dateValue = exifDate
      ? exifDate.toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10)

    const { error: insertError } = await supabase.from('cutoff_entries').insert([{
      username: ptcgUsername,
      date: dateValue,
      points: pts,
      rank,
      screenshot_url: urlData.publicUrl,
      user_id: session.user.id,
    }])
    setSubmitting(false)
    if (insertError) { setError('Submission failed. Please try again.'); console.error(insertError); return }

    setSubmitted(true)
    clearScreenshot()
    setTimeout(() => { setSubmitted(false); setTab('data') }, 1800)
  }

  // ── Derived ──
  const prediction = getPrediction(entries)
  // Keep only the latest submission per user from the past hour, sorted by most recent
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  const latestPerUser = Object.values(
    entries
      .filter(e => new Date(e.created_at).getTime() >= oneHourAgo)
      .reduce((acc, e) => {
        if (!acc[e.username] || new Date(e.created_at) > new Date(acc[e.username].created_at)) acc[e.username] = e
        return acc
      }, {})
  ).sort((a, b) => Number(b.points) - Number(a.points))


  const trendColor = {
    rising:  { bg: 'rgba(16,185,129,0.15)',  border: 'rgba(16,185,129,0.4)',  text: '#34d399' },
    falling: { bg: 'rgba(239,68,68,0.15)',   border: 'rgba(239,68,68,0.4)',   text: '#f87171' },
    stable:  { bg: 'rgba(108,99,255,0.15)',  border: 'rgba(108,99,255,0.4)',  text: '#818cf8' },
  }
  const trendLabel = { rising: '↑ Rising', falling: '↓ Falling', stable: '→ Stable' }

  const needsProfileSetup = !!session && !ptcgUsername

  // ── Render ──
  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #0a0a18 0%, #0d0b1f 50%, #110a14 100%)', fontFamily: "'DM Sans', sans-serif", color: '#e8e0ff', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'fixed', top: '-10%', left: '-10%', width: 500, height: 500, borderRadius: '50%', background: 'radial-gradient(circle, rgba(108,99,255,0.15) 0%, transparent 70%)', pointerEvents: 'none', zIndex: 0 }} />
      <div style={{ position: 'fixed', bottom: '-15%', right: '-5%', width: 600, height: 600, borderRadius: '50%', background: 'radial-gradient(circle, rgba(220,100,30,0.07) 0%, transparent 70%)', pointerEvents: 'none', zIndex: 0 }} />
      <div style={{ position: 'fixed', top: '30%', right: '-5%', width: 400, height: 400, borderRadius: '50%', background: 'radial-gradient(circle, rgba(56,189,248,0.06) 0%, transparent 70%)', pointerEvents: 'none', zIndex: 0 }} />
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, backgroundImage: 'linear-gradient(rgba(108,99,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(108,99,255,0.03) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

      {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}

      {/* Outer layout: sidebars + main */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', gap: 16, padding: '0 12px' }}>

        {/* Left ad */}
        <aside style={{ width: 160, flexShrink: 0, paddingTop: 48, position: 'sticky', top: 24, display: 'none' }} className="ad-sidebar">
          <AdUnit slot="1234567890" format="vertical" />
        </aside>

        <div style={{ position: 'relative', zIndex: 1, maxWidth: 820, width: '100%', padding: '36px 8px 80px', opacity: animIn ? 1 : 0, transform: animIn ? 'translateY(0)' : 'translateY(18px)', transition: 'opacity 0.7s ease, transform 0.7s ease' }}>

        <SeasonTimer />

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 11, letterSpacing: 5, textTransform: 'uppercase', color: '#6C63FF', fontWeight: 700, fontFamily: 'Rajdhani, sans-serif', marginBottom: 8 }}>◆ Pokémon TCG Pocket ◆</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <img src="/masterball.svg" alt="" style={{ width: 64, height: 64, flexShrink: 0, filter: 'drop-shadow(0 0 24px rgba(123,53,168,0.7))' }} />
            <h1 style={{ fontSize: 'clamp(2rem, 6vw, 3.4rem)', fontWeight: 900, fontFamily: 'Rajdhani, sans-serif', background: 'linear-gradient(135deg, #fde68a 0%, #f59e0b 30%, #c4b5fd 70%, #38bdf8 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: 1, lineHeight: 1.1, margin: 0 }}>
              Master Ball Cutoff Tracker
            </h1>
            <img src="/masterball.svg" alt="" style={{ width: 64, height: 64, flexShrink: 0, filter: 'drop-shadow(0 0 24px rgba(123,53,168,0.7))' }} />
          </div>
          <p style={{ margin: '8px 0 0', color: '#a78bfa', fontSize: 15, fontWeight: 500 }}>Community-powered Top 10,000 Points Predictor</p>

          {/* Auth status bar */}
          {!authLoading && session && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginTop: 12, background: 'rgba(108,99,255,0.08)', border: '1px solid rgba(108,99,255,0.2)', borderRadius: 20, padding: '5px 14px' }}>
              <span style={{ fontSize: 12, color: '#a78bfa' }}>
                Signed in as <strong style={{ color: '#c4b5fd' }}>{ptcgUsername || session.user.email}</strong>
              </span>
              {ptcgUsername && (
                <button onClick={() => setPtcgUsername('')} style={{ background: 'none', border: 'none', color: '#4a4070', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', padding: 0 }}>
                  · change name
                </button>
              )}
              <button onClick={() => supabase.auth.signOut()} style={{ background: 'none', border: 'none', color: '#4a4070', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', padding: 0 }}>
                · sign out
              </button>
            </div>
          )}
        </div>

        {dbError && <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 12, padding: '12px 18px', marginBottom: 20, color: '#f87171', fontSize: 13 }}>⚠️ {dbError}</div>}


        {/* Prediction */}
        {prediction && (
          <div style={{ background: 'linear-gradient(135deg, rgba(108,99,255,0.12) 0%, rgba(56,189,248,0.07) 100%)', border: '1px solid rgba(108,99,255,0.35)', borderRadius: 18, padding: '22px 28px', marginBottom: 28, backdropFilter: 'blur(12px)', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: -20, right: -20, width: 120, height: 120, borderRadius: '50%', background: 'radial-gradient(circle, rgba(108,99,255,0.2) 0%, transparent 70%)', pointerEvents: 'none' }} />
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', color: '#818cf8', marginBottom: 6, fontFamily: 'Rajdhani, sans-serif', fontWeight: 700 }}>✦ Predicted Cutoff (End of Month)</div>
                <div style={{ fontSize: 'clamp(2rem, 7vw, 3.2rem)', fontWeight: 900, color: '#c4b5fd', lineHeight: 1, fontFamily: 'Rajdhani, sans-serif' }}>
                  {formatPoints(prediction.predicted)}<span style={{ fontSize: 14, color: '#818cf8', fontWeight: 500, marginLeft: 8 }}>pts</span>
                </div>
                <div style={{ fontSize: 13, color: '#7c6fa0', marginTop: 4 }}>for {prediction.endOfMonth.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ display: 'inline-block', padding: '5px 14px', borderRadius: 20, background: trendColor[prediction.trend].bg, border: `1px solid ${trendColor[prediction.trend].border}`, color: trendColor[prediction.trend].text, fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', fontFamily: 'Rajdhani, sans-serif' }}>
                  {trendLabel[prediction.trend]}
                </div>
                <div style={{ fontSize: 11, color: '#7c6fa0', marginTop: 8 }}>Confidence: {Math.round(prediction.r2 * 100)}% (R²)</div>
                <div style={{ fontSize: 11, color: '#7c6fa0', marginTop: 2 }}>Based on {entries.length} data point{entries.length !== 1 ? 's' : ''}</div>
              </div>
            </div>
          </div>
        )}

        {entries.length === 1 && (
          <div style={{ background: 'rgba(108,99,255,0.06)', border: '1px dashed rgba(108,99,255,0.25)', borderRadius: 12, padding: '12px 18px', marginBottom: 24, fontSize: 13, color: '#7c6fa0', textAlign: 'center' }}>
            📊 Need at least <strong style={{ color: '#a78bfa' }}>2 data points</strong> to unlock the cutoff prediction
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, background: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 4, border: '1px solid rgba(108,99,255,0.15)' }}>
          {[['submit', '🎯 Submit Snapshot'], ['data', `📊 Community Data (${latestPerUser.length})`]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{ flex: 1, padding: '10px 0', borderRadius: 9, border: 'none', cursor: 'pointer', fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: 15, letterSpacing: 0.5, background: tab === key ? 'linear-gradient(135deg, #6C63FF, #818cf8)' : 'transparent', color: tab === key ? '#fff' : '#7c6fa0', transition: 'all 0.2s', boxShadow: tab === key ? '0 4px 12px rgba(108,99,255,0.35)' : 'none' }}>
              {label}
            </button>
          ))}
        </div>

        {/* Submit tab */}
        {tab === 'submit' && (
          authLoading ? (
            <div style={{ padding: 50, textAlign: 'center', color: '#7c6fa0' }}>Loading…</div>
          ) : !session ? (
            <LoginView />
          ) : needsProfileSetup ? (
            <ProfileSetup onComplete={name => setPtcgUsername(name)} />
          ) : (
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(108,99,255,0.2)', borderRadius: 18, padding: '28px', backdropFilter: 'blur(10px)', animation: 'fadeSlideIn 0.35s ease' }}>
              <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 800, color: '#c4b5fd', fontFamily: 'Rajdhani, sans-serif' }}>Report Your Cutoff Snapshot</h2>
              <p style={{ margin: '0 0 24px', fontSize: 13, color: '#7c6fa0' }}>Upload your ranking screenshot — points and rank are read automatically.</p>

              {submitted ? (
                <div style={{ textAlign: 'center', padding: '44px 0', animation: 'fadeIn 0.4s ease' }}>
                  <div style={{ fontSize: 52, marginBottom: 12 }}>✅</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#34d399', fontFamily: 'Rajdhani, sans-serif' }}>Submitted!</div>
                  <div style={{ fontSize: 13, color: '#7c6fa0', marginTop: 4 }}>Taking you to the community data…</div>
                </div>
              ) : (
                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

                  {/* Submitting as */}
                  <div style={{ background: 'rgba(108,99,255,0.08)', border: '1px solid rgba(108,99,255,0.2)', borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 13, color: '#7c6fa0' }}>Submitting as <strong style={{ color: '#a78bfa' }}>{ptcgUsername}</strong></span>
                    <button type="button" onClick={() => setPtcgUsername('')} style={{ background: 'none', border: 'none', color: '#4a4070', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>Change</button>
                  </div>

                  <ScreenshotUpload file={screenshotFile} preview={screenshotPreview} onFile={handleScreenshotFile} onClear={clearScreenshot} />

                  {exifDate && (
                    <div style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 10, padding: '8px 14px', fontSize: 12, color: '#34d399', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>📅</span>
                      <span>Screenshot taken: <strong>{formatDateTime(exifDate)}</strong> — using this as the submission date.</span>
                    </div>
                  )}

                  <OcrStatus status={ocrStatus} message={ocrMessage} />

                  {ocrPassed && ocrExtracted.points && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                      {[
                        { label: 'Username', value: ocrExtracted.username },
                        { label: 'Rank',     value: `#${ocrExtracted.rank?.toLocaleString()}` },
                        { label: 'Points',   value: formatPoints(ocrExtracted.points) },
                      ].map(({ label, value }) => (
                        <div key={label} style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 10, padding: '12px 14px', textAlign: 'center' }}>
                          <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase', color: '#34d399', fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, marginBottom: 4 }}>{label}</div>
                          <div style={{ fontSize: 15, fontWeight: 800, color: '#e8e0ff', fontFamily: 'Rajdhani, sans-serif' }}>{value}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {error && <div style={{ color: '#f87171', fontSize: 13, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, padding: '10px 14px' }}>⚠️ {error}</div>}

                  <button type="submit" disabled={submitting || ocrStatus === 'scanning'} style={{ marginTop: 4, padding: '14px 0', borderRadius: 12, border: 'none', cursor: (submitting || ocrStatus === 'scanning') ? 'not-allowed' : 'pointer', background: (submitting || ocrStatus === 'scanning') ? 'rgba(108,99,255,0.3)' : 'linear-gradient(135deg, #6C63FF 0%, #8b5cf6 50%, #38bdf8 100%)', color: '#fff', fontFamily: 'Rajdhani, sans-serif', fontWeight: 800, fontSize: 17, letterSpacing: 0.5, boxShadow: (submitting || ocrStatus === 'scanning') ? 'none' : '0 6px 20px rgba(108,99,255,0.4)', transition: 'all 0.2s', opacity: (submitting || ocrStatus === 'scanning') ? 0.7 : 1 }}>
                    {submitting ? 'Uploading & Submitting…' : ocrStatus === 'scanning' ? '🔍 Scanning Screenshot…' : 'Submit Snapshot ✦'}
                  </button>

                  <p style={{ margin: 0, fontSize: 11, color: '#4a4070', textAlign: 'center' }}>Screenshots are scanned via OCR · All submissions are public</p>
                </form>
              )}
            </div>
          )
        )}

        {/* Data tab */}
        {tab === 'data' && (
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(108,99,255,0.2)', borderRadius: 18, overflow: 'hidden', backdropFilter: 'blur(10px)', animation: 'fadeSlideIn 0.35s ease' }}>
            <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid rgba(108,99,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: '#c4b5fd', fontFamily: 'Rajdhani, sans-serif' }}>Community Submissions</span>
              <button onClick={fetchEntries} style={{ background: 'rgba(108,99,255,0.15)', border: '1px solid rgba(108,99,255,0.3)', borderRadius: 8, color: '#818cf8', cursor: 'pointer', fontSize: 13, padding: '5px 12px', fontFamily: 'inherit' }}>↻</button>
            </div>

            {loading ? (
              <div style={{ padding: 50, textAlign: 'center', color: '#7c6fa0' }}>Loading data…</div>
            ) : entries.length === 0 ? (
              <div style={{ padding: '60px 24px', textAlign: 'center' }}>
                <div style={{ fontSize: 44, marginBottom: 12 }}>🏆</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#a78bfa', fontFamily: 'Rajdhani, sans-serif' }}>No submissions yet</div>
                <div style={{ fontSize: 13, color: '#7c6fa0', marginTop: 4 }}>Be the first to submit a snapshot!</div>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 540 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(108,99,255,0.2)' }}>
                      {['#', 'Username', 'Uploaded', 'Points', 'Rank', 'Proof'].map((h, i) => (
                        <th key={h} style={{ padding: '12px 16px', textAlign: (i >= 3 && i <= 4) ? 'right' : 'left', fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: '#6C63FF', fontWeight: 700, background: 'rgba(108,99,255,0.07)', fontFamily: 'Rajdhani, sans-serif' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {latestPerUser.map((e, i) => (
                      <tr key={e.id}
                        style={{ borderBottom: '1px solid rgba(108,99,255,0.08)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)', transition: 'background 0.15s' }}
                        onMouseEnter={ev => ev.currentTarget.style.background = 'rgba(108,99,255,0.08)'}
                        onMouseLeave={ev => ev.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)'}
                      >
                        <td style={{ padding: '11px 16px', fontSize: 14 }}>{['🥇','🥈','🥉'][i] ?? <span style={{ color: '#4a4070' }}>{i + 1}</span>}</td>
                        <td style={{ padding: '11px 16px', fontWeight: 700, color: i === 0 ? '#fde68a' : '#c4b5fd', fontSize: 14 }}>{e.username}</td>
                        <td style={{ padding: '11px 16px', color: '#9ca3af', fontSize: 13 }}>{formatDateTime(e.created_at)}</td>
                        <td style={{ padding: '11px 16px', textAlign: 'right', color: '#f59e0b', fontWeight: 800, fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>{formatPoints(e.points)}</td>
                        <td style={{ padding: '11px 16px', textAlign: 'right', color: '#818cf8', fontWeight: 700, fontSize: 14 }}>#{Number(e.rank).toLocaleString()}</td>
                        <td style={{ padding: '11px 16px' }}>
                          {e.screenshot_url ? (
                            <button onClick={() => setLightboxUrl(e.screenshot_url)} style={{ background: 'rgba(108,99,255,0.15)', border: '1px solid rgba(108,99,255,0.3)', borderRadius: 7, color: '#a78bfa', cursor: 'pointer', fontSize: 11, padding: '4px 10px', fontFamily: 'inherit', fontWeight: 700, transition: 'all 0.15s' }}
                              onMouseEnter={e => { e.target.style.background = 'rgba(108,99,255,0.3)' }}
                              onMouseLeave={e => { e.target.style.background = 'rgba(108,99,255,0.15)' }}
                            >📸 View</button>
                          ) : <span style={{ fontSize: 11, color: '#3a305a' }}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <p style={{ textAlign: 'center', fontSize: 11, color: '#2e2647', marginTop: 32 }}>Community-sourced data · Not affiliated with DeNA or The Pokémon Company</p>
        </div>{/* inner content */}

        {/* Right ad */}
        <aside style={{ width: 160, flexShrink: 0, paddingTop: 48, position: 'sticky', top: 24, display: 'none' }} className="ad-sidebar">
          <AdUnit slot="0987654321" format="vertical" />
        </aside>

      </div>{/* outer flex layout */}
    </div>
  )
}
