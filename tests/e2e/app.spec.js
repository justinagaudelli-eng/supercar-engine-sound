// End-to-end: the production build (vite preview, port 4173) in headless Chromium.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const BASE = 'http://localhost:4173/'
const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/index.json', import.meta.url)))
const RATE = 4 // replays run 4× faster than real time here

/** Collect console errors + page errors for the whole test. */
function watchErrors(page) {
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

const appState = (page) => page.evaluate(() => window.__gt3rs.state)

async function startEngine(page) {
  // A real click = a user gesture, which is what unlocks the AudioContext.
  await page.click('#btn-engine')
  await expect.poll(async () => (await appState(page)).ctxState, { timeout: 10_000 }).toBe('running')
  await expect.poll(async () => (await appState(page)).engineState, { timeout: 10_000 }).toBe('running')
  // Startup flare settles back to idle.
  await expect.poll(async () => (await appState(page)).rpm, { timeout: 10_000 }).toBeLessThan(1100)
}

test.describe('built site', () => {
  test('loads with no console errors and shows the instruments', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto(BASE)
    await expect(page.locator('#tach')).toBeVisible()
    await expect(page.locator('#btn-engine')).toBeVisible()
    await page.waitForTimeout(500)
    expect(errors).toEqual([])
  })

  test('audio stays locked until Start, then starts and stops cleanly', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto(`${BASE}?replayRate=${RATE}`)
    expect((await appState(page)).ctxState).toBeNull() // nothing created before the tap
    await startEngine(page)
    const s = await appState(page)
    expect(s.levels.master).toBeGreaterThan(-60) // something is actually playing
    await page.click('#btn-engine') // Stop
    await expect.poll(async () => (await appState(page)).engineState, { timeout: 5000 }).toBe('off')
    expect(errors).toEqual([])
  })

  test('simulator drives rpm and gears', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto(BASE)
    await page.click('#source [data-value="sim"]')
    await startEngine(page)
    await page.evaluate(() => {
      // Hold the throttle slider at 100 % via the keyboard handler (End key = max).
      const el = document.getElementById('sim-throttle')
      document.getElementById('release-to-zero').checked = false
      document.getElementById('release-to-zero').dispatchEvent(new Event('change'))
      el.focus()
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    await expect.poll(async () => (await appState(page)).gear, { timeout: 15_000 }).toBeGreaterThanOrEqual(3)
    const s = await appState(page)
    expect(s.speedMps).toBeGreaterThan(20)
    expect(s.ctxState).toBe('running')
    expect(errors).toEqual([])
  })

  test('every replay fixture runs through the app without errors', async ({ page }) => {
    test.setTimeout(240_000)
    const errors = watchErrors(page)
    await page.goto(`${BASE}?replayRate=${RATE}`)
    await page.click('#source [data-value="replay"]')
    await startEngine(page)

    for (const fx of fixtures) {
      await page.selectOption('#replay-fixture', fx.name)
      await page.click('#btn-replay-play')
      const seen = { maxRpm: 0, maxSpeed: 0, gears: new Set(), statuses: new Set() }
      const gpsTexts = new Set()
      const deadline = Date.now() + (fx.durationS / RATE) * 1000 + 3000
      while (Date.now() < deadline) {
        const s = await appState(page)
        seen.maxRpm = Math.max(seen.maxRpm, s.rpm)
        seen.maxSpeed = Math.max(seen.maxSpeed, s.speedMps)
        seen.gears.add(s.gear)
        seen.statuses.add(s.status)
        gpsTexts.add(await page.textContent('#gps-status-text'))
        expect(s.ctxState, `${fx.name}: AudioContext`).toBe('running')
        if (!s.replayPlaying) break
        await page.waitForTimeout(150)
      }
      expect(seen.maxSpeed, `${fx.name}: speed`).toBeGreaterThan(3)
      expect(seen.maxRpm, `${fx.name}: rpm`).toBeGreaterThan(1200)
      expect(gpsTexts.size, `${fx.name}: status line updates`).toBeGreaterThan(1)
      if (fx.name === 'gps-dropout') expect([...seen.statuses]).toContain('stale')
    }
    const s = await appState(page)
    expect(s.errors).toEqual([])
    expect(errors).toEqual([])
  })

  test('rapid Start/Stop/Start builds exactly one engine; Stop suspends audio', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto(BASE)
    await page.click('#btn-engine') // start
    await page.click('#btn-engine') // stop (while the worklet may still be loading)
    await page.click('#btn-engine') // start again
    await expect.poll(async () => (await appState(page)).engineState, { timeout: 10_000 }).toBe('running')
    expect((await appState(page)).enginesBuilt).toBe(1)
    await page.click('#btn-engine') // stop
    await expect.poll(async () => (await appState(page)).ctxState, { timeout: 6000 }).toBe('suspended')
    await startEngine(page) // and it comes back
    expect((await appState(page)).enginesBuilt).toBe(1)
    expect(errors).toEqual([])
  })

  test('reload mid-drive offers one-tap resume straight to idle', async ({ page }) => {
    await page.goto(BASE)
    await startEngine(page)
    await page.reload()
    await expect(page.locator('#resume-overlay')).toBeVisible()
    await page.click('#btn-resume')
    await expect.poll(async () => (await appState(page)).engineState, { timeout: 5000 }).toBe('running')
    // Warm start: no cranking flare, straight to idle.
    await page.waitForTimeout(400)
    expect((await appState(page)).rpm).toBeLessThan(1100)
    await expect(page.locator('#resume-overlay')).toBeHidden()
  })

  test('settings persist across reloads', async ({ page }) => {
    await page.goto(BASE)
    await page.click('#preset [data-value="track"]')
    await page.fill('#volume', '40')
    await page.dispatchEvent('#volume', 'input')
    await page.reload()
    await expect(page.locator('#preset [data-value="track"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#volume')).toHaveValue('40')
  })

  test('launch control: 2-step while stopped, launches on drive-off, then disarms', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto(BASE)
    await expect(page.locator('#btn-launch')).toBeDisabled() // engine off
    await page.click('#source [data-value="sim"]')
    await startEngine(page)
    await page.click('#btn-launch')
    await expect(page.locator('#btn-launch')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await appState(page)).rpm, { timeout: 5000 }).toBeGreaterThan(5300)
    // Bouncing on the 2-step: rpm stays in the band and the ignition cuts.
    let cuts = 0
    for (let i = 0; i < 25; i++) {
      const s = await appState(page)
      expect(s.rpm).toBeGreaterThan(5300)
      expect(s.rpm).toBeLessThanOrEqual(6000)
      if (s.cut > 0) cuts++
      await page.waitForTimeout(37)
    }
    expect(cuts).toBeGreaterThan(3)
    // Floor it: the car moves off, launch control disarms itself (no tap needed while moving).
    await page.evaluate(() => {
      const el = document.getElementById('sim-throttle')
      document.getElementById('release-to-zero').checked = false
      document.getElementById('release-to-zero').dispatchEvent(new Event('change'))
      el.focus()
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    await expect.poll(async () => (await appState(page)).launch, { timeout: 5000 }).toBe(false)
    await expect(page.locator('#btn-launch')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('#btn-launch')).toBeDisabled() // moving
    await expect.poll(async () => (await appState(page)).gear, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    expect(errors).toEqual([])
  })

  test('shift style setting persists', async ({ page }) => {
    await page.goto(BASE)
    await expect(page.locator('#shift-style [data-value="aggressive"]')).toHaveAttribute('aria-pressed', 'true')
    await page.click('#shift-style [data-value="normal"]')
    await page.reload()
    await expect(page.locator('#shift-style [data-value="normal"]')).toHaveAttribute('aria-pressed', 'true')
  })

  test('switching cars while running restarts the engine as the new car, and persists', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto(BASE)
    await startEngine(page)
    for (const id of ['svj', 'sto', 'temerario', '765lt', 'turbos', 'gt3rs']) {
      await page.selectOption('#car', id)
      await expect.poll(async () => (await appState(page)).car).toBe(id)
      await expect.poll(async () => (await appState(page)).engineState, { timeout: 10_000 }).toBe('running')
      await expect.poll(async () => (await appState(page)).rpm, { timeout: 10_000 }).toBeLessThan(1300)
      await expect.poll(async () => (await appState(page)).levels.master, { timeout: 5000 }).toBeGreaterThan(-60)
    }
    await page.selectOption('#car', 'svj')
    await page.reload()
    await expect(page.locator('#car')).toHaveValue('svj')
    await expect(page.locator('#car-engine')).toContainText('V12')
    expect(errors).toEqual([])
  })

  test('slicer tool page loads', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto(`${BASE}tools/slicer.html`)
    await expect(page.locator('input[type=file]').first()).toBeAttached()
    expect(errors).toEqual([])
  })
})
