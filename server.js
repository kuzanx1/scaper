require('dotenv').config()
const express = require('express')
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const { refreshTitle, runScheduledCheck } = require('./scraper')

puppeteer.use(StealthPlugin())

const app  = express()
const PORT = process.env.PORT || 3001

app.use(express.json())

// ============================================================
//  متغير عام للبراوزر
// ============================================================
let browser = null

const path = require('path')
const { chromium } = require('playwright')

const FASELHD_PROFILE = path.join(__dirname, 'faselhd-profile')
let faselhdContext = null

async function getFaselhdContext() {
  if (!faselhdContext) {
    faselhdContext = await chromium.launchPersistentContext(FASELHD_PROFILE, {
      headless: false,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    })
  }
  return faselhdContext
}

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    })
  }
  return browser
}

// ============================================================
//  API: تحديث سيرفرات عنوان معين
//  POST /refresh
//  Body: { title_id, episode_id? }
// ============================================================
app.post('/refresh', async (req, res) => {
  const { title_id, episode_id } = req.body

  if (!title_id) {
    return res.status(400).json({ error: 'title_id مطلوب' })
  }

  console.log(`\n🔄 طلب تحديث: ${title_id}${episode_id ? ` / ${episode_id}` : ''}`)

  try {
    const b       = await getBrowser()
    const success = await refreshTitle(b, title_id, episode_id || null)

    return res.json({ success, title_id, episode_id })
  } catch (e) {
    console.error('خطأ:', e.message)
    return res.status(500).json({ error: e.message })
  }
})

// ============================================================
//  API: فحص الحالة
//  GET /health
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    browser: browser?.connected ? 'connected' : 'disconnected',
    time: new Date().toISOString(),
  })
})

// ============================================================
//  API: تشغيل الفحص الدوري يدوياً
//  POST /run-check
// ============================================================
app.post('/run-check', async (req, res) => {
  app.post('/faselhd-login', async (req, res) => {
  const ctx  = await getFaselhdContext()
  const page = await ctx.newPage()
  await page.goto('https://web62118xx.faselhdx.xyz/', { waitUntil: 'domcontentloaded' })

  const isChallenge = await page.locator('text=Cloudflare').count().catch(() => 0)
  if (isChallenge) {
    return res.json({ status: 'cloudflare', message: 'افتح المتصفح وتجاوز Cloudflare يدوياً' })
  }

  await page.close()
  return res.json({ status: 'ok', message: 'faselhd جاهز، الجلسة محفوظة' })
})
  res.json({ message: 'بدأ الفحص الدوري في الخلفية' })
  // شغّل في الخلفية بدون انتظار
  runScheduledCheck().catch(console.error)
})

// ============================================================
//  تشغيل السيرفر
// ============================================================
app.listen(PORT, () => {
  console.log(`\x1b[32m✅ Scraper Server شغال على port ${PORT}\x1b[0m`)
  console.log(`   POST /refresh    → تحديث عنوان معين`)
  console.log(`   GET  /health     → فحص الحالة`)
  console.log(`   POST /run-check  → فحص دوري يدوي`)
})

// ============================================================
//  Cron Job: كل ساعة يفحص تلقائياً
// ============================================================
const CHECK_INTERVAL = 60 * 60 * 1000 // ساعة

setInterval(() => {
  console.log('\n⏰ Cron: بدء الفحص التلقائي...')
  runScheduledCheck().catch(console.error)
}, CHECK_INTERVAL)

// تشغيل فوري عند البداية بعد دقيقتين
setTimeout(() => {
  console.log('\n🚀 فحص أولي...')
  runScheduledCheck().catch(console.error)
}, 2 * 60 * 1000)

process.on('SIGINT', async () => {
  console.log('\n🛑 إيقاف السيرفر...')
  if (browser) await browser.close()
if (faselhdContext) await faselhdContext.close()
  process.exit(0)
})