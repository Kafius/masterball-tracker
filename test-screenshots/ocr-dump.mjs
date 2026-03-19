import { createWorker } from 'tesseract.js'
import { readdir } from 'fs/promises'
import { resolve, extname } from 'path'
import { fileURLToPath } from 'url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const files = (await readdir(dir)).filter(f => IMAGE_EXTS.has(extname(f).toLowerCase()))

for (const file of files) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`FILE: ${file}`)
  console.log('─'.repeat(60))
  const worker = await createWorker('eng', 1, { logger: () => {} })
  const { data: { text } } = await worker.recognize(resolve(dir, file))
  await worker.terminate()
  console.log(text)
}
