import { createWorker } from 'tesseract.js'
import { readdir } from 'fs/promises'
import { resolve, extname } from 'path'
import { fileURLToPath } from 'url'

// ── Mirror of App.jsx helpers ─────────────────────────────────────────────────

const UI_SKIP = /^(season|records|refresh|rankings|list|win|rate|wins|losses|last|refreshed|ranked|match|battle|unranked|master|ball|a2b|b2a|b2|b1|streak|at|pm|am|ex)$/i

function parseSeasonCard(text) {
  const ptsMatch = text.match(/([0-9][0-9,]+)\s*pts/i)
  if (!ptsMatch) return { rank: null, username: null, points: null }

  const points = parseInt(ptsMatch[1].replace(/,/g, ''), 10)
  const tokens = text.slice(0, ptsMatch.index).split(/[\s\n\r]+/).filter(t => t.length >= 2)

  // Pass 1: username — last non-numeric, non-UI token before pts
  let username = null
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (!/^[\d,%.]+$/.test(t) && !UI_SKIP.test(t)) { username = t; break }
  }

  // Pass 2: rank — last number in range 1–10,000 before pts
  let rank = null
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (/^[\d,]+$/.test(t)) {
      const n = parseInt(t.replace(/,/g, ''), 10)
      if (n >= 1 && n <= 10000) { rank = n; break }
    }
  }

  if (!rank) {
    const hashMatch = text.match(/#\s*([0-9][0-9,]*)/)
    if (hashMatch) {
      const n = parseInt(hashMatch[1].replace(/,/g, ''), 10)
      if (n >= 1 && n <= 10000) rank = n
    }
  }

  return { rank, username, points }
}

const SEASON_TOKENS = ['b2a', 'b2', 'season 11', 'season11', 'season records', 'ranked']
function ocrContainsSeason(text) {
  const lower = text.toLowerCase()
  return SEASON_TOKENS.some(token => lower.includes(token))
}

// ── Main ──────────────────────────────────────────────────────────────────────

const dir = fileURLToPath(new URL('.', import.meta.url))
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

const files = (await readdir(dir))
  .filter(f => IMAGE_EXTS.has(extname(f).toLowerCase()))

if (files.length === 0) {
  console.log('No images found in test-screenshots/. Drop some screenshots in and re-run.')
  process.exit(0)
}

console.log(`\nScanning ${files.length} screenshot(s)…\n`)

for (const file of files) {
  const imagePath = resolve(dir, file)
  console.log(`── ${file} ──`)

  try {
    const worker = await createWorker('eng', 1, { logger: () => {} })
    const { data: { text } } = await worker.recognize(imagePath)
    await worker.terminate()

    console.log('Raw OCR text:')
    console.log(text)
    console.log()

    const isUnranked = /unranked/i.test(text)
    if (isUnranked) {
      console.log('❌ BLOCKED — "Unranked" detected\n')
      continue
    }

    const { rank, username, points } = parseSeasonCard(text)
    const foundSeason = ocrContainsSeason(text)

    console.log('Extracted:')
    console.log(`  username : ${username ?? '(not found)'}`)
    console.log(`  rank     : ${rank ?? '(not found)'}`)
    console.log(`  points   : ${points ?? '(not found)'}`)
    console.log(`  season   : ${foundSeason ? 'confirmed' : 'not detected'}`)

    const missing = [!points && 'points', !rank && 'rank', !username && 'username'].filter(Boolean)
    if (missing.length) {
      console.log(`\n❌ FAIL — could not extract: ${missing.join(', ')}\n`)
    } else {
      console.log(`\n${foundSeason ? '✅' : '⚠️ '} ${foundSeason ? 'PASS' : 'WARN (season unconfirmed)'} — ${username} · #${rank.toLocaleString()} · ${points.toLocaleString()} pts\n`)
    }
  } catch (err) {
    console.log(`⚠️  ERROR — ${err.message}\n`)
  }
}
