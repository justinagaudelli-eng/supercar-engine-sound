// Screenshots of the built app mid-launch (simulator) at parked and while-driving sizes.
// Usage: npm run build && npx vite preview --port 4173 &  node scripts/screenshot.mjs [baseUrl]
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const base = process.argv[2] ?? 'http://localhost:4173/'
const out = new URL('../reports/screenshots/', import.meta.url).pathname
mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
for (const [w, h, name] of [[1600, 1000, 'parked-1600x1000'], [773, 601, 'driving-773x601']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  await page.goto(base)
  await page.screenshot({ path: `${out}${name}-idle-ui.png` })
  await page.click('#source [data-value="sim"]')
  await page.click('#btn-engine')
  await page.waitForTimeout(3500)
  await page.evaluate(() => {
    const r = document.getElementById('release-to-zero'); r.checked = false; r.dispatchEvent(new Event('change'))
    const el = document.getElementById('sim-throttle'); el.focus()
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  })
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: `${out}${name}-launch.png` })
  console.log(name, JSON.stringify(await page.evaluate(() => window.__gt3rs.state)))
}
await browser.close()
