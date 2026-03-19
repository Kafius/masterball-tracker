import { createWorker } from 'tesseract.js'
import { readdir } from 'fs/promises'
import { resolve, extname } from 'path'
import { fileURLToPath } from 'url'

// ── Mirror of current App.jsx helpers ─────────────────────────────────────────

const UI_SKIP = /^(season|records|refresh|rankings|list|win|rate|wins|losses|last|refreshed|ranked|match|battle|unranked|master|ball|a2b|b2a|b2|b1|streak|at|pm|am|ex)$/i
const SEASON_TOKENS = ['b2a', 'b2', 'season 11', 'season11', 'season records', 'ranked']

function ocrContainsSeason(text) {
  return SEASON_TOKENS.some(token => text.toLowerCase().includes(token))
}

function parseSeasonCard(text) {
  const ptsMatch = text.match(/([0-9][0-9,]+)\s*pts/i)
  if (!ptsMatch) return { rank: null, username: null, points: null }

  const points = parseInt(ptsMatch[1].replace(/,/g, ''), 10)
  const textBefore = text.slice(0, ptsMatch.index)
  const tokens = textBefore.split(/[\s\n\r]+/).filter(t => t.length >= 1)

  // Unranked: "-" alone on its own line (rank badge shows dash)
  const isUnranked = /^\s*[-–—]\s*$/m.test(textBefore)

  // Pass 1: username — last non-numeric, non-UI, non-dash token of 2+ chars before pts
  // Requiring length >= 2 filters out single-char OCR artifacts (e.g. "H" from avatar borders)
  let username = null
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (t.length >= 2 && !/^[\d,%.]+$/.test(t) && !UI_SKIP.test(t) && !/^[-–—]+$/.test(t)) { username = t; break }
  }

  if (isUnranked) return { rank: null, username, points, isUnranked: true }

  // Pass 2: rank — prefer standalone number on its own line (rank badge),
  // searching only AFTER "Season Records" header to skip the status bar (battery %, time)
  let rank = null
  const seasonIdx = textBefore.search(/season\s*records/i)
  const rankSearchRegion = seasonIdx !== -1
    ? textBefore.slice(seasonIdx)
    : textBefore.split('\n').slice(1).join('\n')

  const standaloneMatch = rankSearchRegion.match(/^\s*([0-9][0-9,]*)\s*$/m)
  if (standaloneMatch) {
    const n = parseInt(standaloneMatch[1].replace(/,/g, ''), 10)
    if (n >= 1 && n <= 10000) rank = n
  }

  // Fallback: last number in range across all tokens
  if (!rank) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i]
      if (/^[\d,]+$/.test(t)) {
        const n = parseInt(t.replace(/,/g, ''), 10)
        if (n >= 1 && n <= 10000) { rank = n; break }
      }
    }
  }

  // Fallback: # pattern
  if (!rank) {
    const hashMatch = text.match(/#\s*([0-9][0-9,]*)/)
    if (hashMatch) {
      const n = parseInt(hashMatch[1].replace(/,/g, ''), 10)
      if (n >= 1 && n <= 10000) rank = n
    }
  }

  return { rank, username, points }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const dir = fileURLToPath(new URL('.', import.meta.url))
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const files = (await readdir(dir)).filter(f => IMAGE_EXTS.has(extname(f).toLowerCase()))

if (files.length === 0) {
  console.log('No images found in test-screenshots/. Drop screenshots in and re-run.')
  process.exit(0)
}

console.log(`\nScanning ${files.length} screenshot(s)…\n`)

for (const file of files) {
  const imagePath = resolve(dir, file)
  console.log(`${'─'.repeat(60)}`)
  console.log(`FILE: ${file}`)
  console.log(`${'─'.repeat(60)}`)

  try {
    const worker = await createWorker('eng', 1, { logger: () => {} })
    const { data: { text } } = await worker.recognize(imagePath)
    await worker.terminate()

    console.log('\n=== RAW OCR TEXT ===')
    console.log(text)
    console.log('=== END RAW TEXT ===\n')

    // Unranked via explicit text
    if (/unranked/i.test(text)) {
      console.log('❌ BLOCKED — "Unranked" text detected\n')
      continue
    }

    const { rank, username, points, isUnranked } = parseSeasonCard(text)

    if (isUnranked) {
      console.log(`❌ BLOCKED — Unranked dash detected in rank badge`)
      console.log(`   (username read as: ${username ?? '(none)'})\n`)
      continue
    }

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
      console.log(`\n${foundSeason ? '✅ PASS' : '⚠️  WARN (season unconfirmed)'} — ${username} · #${rank?.toLocaleString()} · ${points?.toLocaleString()} pts\n`)
    }
  } catch (err) {
    console.log(`⚠️  ERROR — ${err.message}\n`)
  }
}
