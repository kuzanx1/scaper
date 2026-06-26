const { chromium } = require('playwright')
require('dotenv').config()
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const { createClient } = require('@supabase/supabase-js')

puppeteer.use(StealthPlugin())

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const CONFIG = {
  sources: [
    {
      name: 'topcinema',
      searchUrl: 'https://web4.topcinema.fan/?s={query}',
      type: 'topcinema',
    },
    {
      name: 'faselhd',
      searchUrl: 'https://web62118xx.faselhdx.xyz/?s={query}',
      type: 'faselhd',
    },
  ],
  embedDomains: [
    'streamwish', 'filelions', 'doodstream', 'streamtape',
    'uqload', 'mixdrop', 'vidhide', 'filemoon', 'upstream',
    'lulustream', 'earnvids', 'updown', 'vidcloud',
  ],
  blockedDomains: [
    'googlesyndication', 'doubleclick', 'googletagmanager',
    'google-analytics', 'facebook.com/tr', 'hotjar',
    'clarity.ms', 'adnxs', 'taboola', 'outbrain',
  ],
  pageTimeout:       20000,
  waitAfterClick:    3000,
  waitAfterAll:      2000,
  tokenExpiryBuffer: 2 * 60 * 60,
  batchSize:         30,
}

const log = {
  info:    (msg) => console.log(`\x1b[36mi  ${msg}\x1b[0m`),
  success: (msg) => console.log(`\x1b[32m✅ ${msg}\x1b[0m`),
  warn:    (msg) => console.log(`\x1b[33m⚠  ${msg}\x1b[0m`),
  error:   (msg) => console.log(`\x1b[31m❌ ${msg}\x1b[0m`),
  title:   (msg) => console.log(`\x1b[35m🎬 ${msg}\x1b[0m`),
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

function isTokenExpired(url) {
  if (!url || !url.includes('.m3u8')) return true
  const match = url.match(/[?&]e=(\d+)/)
  if (!match) return false
  const expiry = parseInt(match[1])
  const nowSec = Math.floor(Date.now() / 1000)
  return expiry - nowSec < CONFIG.tokenExpiryBuffer
}

async function getExpiredServers() {
  const { data: servers, error } = await supabase
    .from('servers')
    .select(`
      id,
      title_id,
      episode_id,
      server_url,
      titles!inner (
        id,
        original_title,
        year,
        type,
        is_published
      )
    `)
    .eq('is_embed', false)
    .eq('is_active', true)
    .not('server_url', 'is', null)

  if (error || !servers) {
    log.error(`فشل جلب السيرفرات: ${error?.message}`)
    return []
  }

  const expired = servers.filter(s => {
    if (!s.titles?.is_published) return false
    return isTokenExpired(s.server_url)
  })

  log.info(`${servers.length} سيرفر اجمالي — ${expired.length} منتهي`)
  return expired
}

function sortByYear(items) {
  return [...items].sort((a, b) => {
    const ya = parseInt(a.titles?.year) || 0
    const yb = parseInt(b.titles?.year) || 0
    return yb - ya
  })
}

function groupExpiredByTitle(expiredServers) {
  const map = new Map()
  for (const s of expiredServers) {
    const key = `${s.title_id}::${s.episode_id || 'null'}`
    if (!map.has(key)) {
      map.set(key, {
        title_id:   s.title_id,
        episode_id: s.episode_id,
        title:      s.titles,
        servers:    [],
      })
    }
    map.get(key).servers.push(s)
  }
  return [...map.values()]
}

function isBlocked(url) {
  return CONFIG.blockedDomains.some(d => url.includes(d))
}

function isEmbedDomain(url) {
  return CONFIG.embedDomains.some(d => url.includes(d))
}

function cleanTitleForSearch(title, year) {
  if (!title) return ''
  let clean = title.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (year) clean = `${clean} ${year}`
  return clean
}

function setupM3u8Interceptor(page, m3u8Map) {
  page.on('response', async (response) => {
    try {
      const url    = response.url()
      const status = response.status()
      if (
        url.includes('.m3u8') &&
        !url.includes('index-v1-a1.m3u8') &&
        !url.includes('.ts') &&
        status >= 200 && status < 400 &&
        !isBlocked(url)
      ) {
        const key = url.split('?')[0]
        if (!m3u8Map.has(key)) m3u8Map.set(key, { url, type: 'm3u8' })
      }
    } catch {}
  })
}

async function extractEmbeds(page, embedMap) {
  try {
    const srcs = await page.evaluate(() =>
      [...document.querySelectorAll('iframe')]
        .map(f => f.src || f.getAttribute('data-src') || '')
        .filter(Boolean)
    )
    for (const src of srcs) {
      if (isEmbedDomain(src) && !isBlocked(src)) embedMap.set(src, { url: src })
    }
  } catch {}
}

async function clickAllServers(page, embedMap, m3u8Map) {
  const buttons = await page.$$('li.server--item')
  if (!buttons.length) return
  log.info(`${buttons.length} سيرفر`)
  for (const btn of buttons) {
    try {
      const beforeCount = m3u8Map.size
      await btn.click()
      await wait(CONFIG.waitAfterClick)
      await extractEmbeds(page, embedMap)
await clickAllServers(page, embedMap)
await wait(CONFIG.waitAfterAll)
      // لو ما طلع m3u8 بعد الكليك انتظر أكثر
      if (m3u8Map.size === beforeCount) {
        await wait(1500)
      }
    } catch {}
  }
}
// ============================================================
//  faselhd باستخدام Playwright + persistent context
// ============================================================
const FASELHD_PROFILE = 'C:\\Users\\N\\folim-scraper\\faselhd-profile'

async function searchFaselHD(title, year, seasonNum, episodeNum) {
  const query = cleanTitleForSearch(title, null)

  const searchUrl = `https://web6260xx.faselhdx.xyz/?s=${encodeURIComponent(query)}`

  log.info(`[faselhd] يبحث عن: "${title}"`)

  const { chromium } = require('playwright')
  const context = await chromium.launchPersistentContext(FASELHD_PROFILE, {
    channel: 'chrome',
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  const page = await context.newPage()
  const m3u8List = []
  const allRequests = []

  page.on('request', req => allRequests.push(req.url()))

  page.on('response', async (response) => {
    try {
      const url = response.url()
      if (
        url.includes('.m3u8') &&
        !url.includes('index-v1-a1.m3u8') &&
        response.status() >= 200 && response.status() < 400
      ) {
        m3u8List.push({ url })
        log.info(`[faselhd] m3u8: ${url.slice(0, 80)}`)
      }
    } catch {}
  })

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(4000)

    const isChallenge = await page.locator('text=Cloudflare').count().catch(() => 0)
    if (isChallenge) {
      log.warn(`[faselhd] Cloudflare — انتظر حتى تتجاوزه يدوياً...`)
      await page.waitForTimeout(60000)
      log.info(`[faselhd] متابعة...`)
    }const resultUrl = await page.evaluate(({ t, isEpisode }) => {
      const tLower = t.toLowerCase()
      const tWords = tLower.split(' ').filter(w => w.length > 2)
      for (const a of document.querySelectorAll('a[href*="/movies/"], a[href*="/series/"]')) {
        const text = (a.innerText || '').toLowerCase()
        const href = a.href || ''
        if (!href) continue
        const matched = tWords.filter(w => text.includes(w)).length / tWords.length
        if (matched >= 0.5) {
          if (isEpisode && href.includes('/series/')) return href
          if (!isEpisode && href.includes('/movies/')) return href
        }
      }
      return null
    }, { t: title, isEpisode: Boolean(seasonNum) })

    if (!resultUrl) {
      log.warn(`[faselhd] ما لقى: "${title}"`)
      log.info(`[faselhd] الروابط الموجودة: ${allRequests.filter(u => !u.includes('google')).slice(0, 10).join('\n')}`)
      await context.close()
      return []
    }

    log.info(`[faselhd] وجد: ${resultUrl}`)
    await page.goto(resultUrl, { waitUntil: 'networkidle', timeout: 20000 })
    await page.waitForTimeout(5000)

const serverItems = await page.$$('li[onclick*="player_iframe"]')
log.info(`[faselhd] عدد السيرفرات: ${serverItems.length}`)
for (const item of serverItems) {
  try {
    // استخرج الرابط من الـ onclick مباشرة
    const onclickVal = await item.evaluate(el => el.getAttribute('onclick'))
    const match = onclickVal?.match(/player_iframe\.location\.href\s*=\s*'([^']+)'/)
    if (!match) continue

    const playerUrl = match[1]
    log.info(`[faselhd] player url: ${playerUrl.slice(0, 80)}`)

    const iPage = await context.newPage()
    iPage.on('response', async (response) => {
      try {
        const url = response.url()
        if (url.includes('.m3u8') && !url.includes('index-v1-a1.m3u8') && !url.includes('jwpltx.com') && response.status() >= 200) {
          m3u8List.push({ url })
          log.info(`[faselhd] m3u8: ${url.slice(0, 80)}`)
        }
      } catch {}
    })
    await iPage.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await iPage.waitForTimeout(4000)
    await iPage.close()

  } catch {}
}
    for (const item of serverItems) {
  try {
    await item.click()
    await page.waitForTimeout(2000)

    const iframeSrc = await page.evaluate(() => {
      const f = document.querySelector('iframe#player_iframe, iframe[name="player_iframe"]')
      return f ? (f.src || f.getAttribute('src')) : null
    })

    if (iframeSrc) {
      log.info(`[faselhd] iframe src: ${iframeSrc}`)
      const iPage = await context.newPage()
      iPage.on('response', async (response) => {
        try {
          const url = response.url()
          if (url.includes('.m3u8') && !url.includes('index-v1-a1.m3u8') && !url.includes('jwpltx.com') && response.status() >= 200) {
            m3u8List.push({ url })
            log.info(`[faselhd] m3u8: ${url.slice(0, 80)}`)
          }
        } catch {}
      })
      await iPage.goto(iframeSrc, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await iPage.waitForTimeout(4000)
      await iPage.close()
    }
  } catch {}
}
    await page.waitForTimeout(1500)

    if (m3u8List.length) {
      log.success(`[faselhd] ${m3u8List.length} m3u8 <- ${title}`)
    } else {
      log.warn(`[faselhd] ما طلع m3u8: "${title}"`)
      log.info(`[faselhd] الروابط اللي التقطها:`)
      allRequests
        .filter(u => !u.includes('google') && !u.includes('facebook') && !u.includes('cloudflare'))
        .slice(0, 30)
        .forEach(u => log.info(`  ${u.slice(0, 120)}`))
    }

    await context.close()
    return m3u8List

  } catch (e) {
    log.error(`[faselhd] فشل: ${title} | ${e.message}`)
    await context.close()
    return []
  }
}
async function searchInSource(browser, source, title, year, seasonNum, episodeNum) {
  const query     = cleanTitleForSearch(title, year)
  const searchUrl = source.searchUrl.replace('{query}', encodeURIComponent(query))

  log.info(`[${source.name}] يبحث عن: "${title}"`)

  const context = await browser.createBrowserContext()
  const page    = await context.newPage()
  const m3u8Map = new Map()
  const embedMap = new Map()

  await page.setRequestInterception(true)
  page.on('request', req => {
    const t = req.resourceType()
    if (isBlocked(req.url()) || t === 'font' || t === 'stylesheet' || t === 'image' || t === 'media')
      return req.abort()
    req.continue()
  })

  setupM3u8Interceptor(page, m3u8Map)
  await page.evaluateOnNewDocument(() => { window.open = () => null })
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36')

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
    await wait(1000)
// faselhd يحتاج انتظار إضافي لتحميل نتائج البحث
if (source.type === 'faselhd') {
  await wait(2000)
  log.info(`[faselhd DEBUG URL] ${page.url()}`)
}

    // DEBUG مؤقت — احذفه بعد ما نشوف النتيجة
    if (source.type === 'faselhd') {
      const debugLinks = await page.evaluate(() =>
        [...document.querySelectorAll('a')].slice(0, 30).map(a => ({
          href: a.href?.slice(0, 80),
          text: a.innerText?.trim().slice(0, 40)
        })).filter(x => x.href && x.href !== '#')
      )
      log.info(`[faselhd DEBUG] ${JSON.stringify(debugLinks, null, 2)}`)
    }

    // ── topcinema ──
    if (source.type === 'topcinema') {
      const resultUrl = await page.evaluate((t, isEpisode) => {
        const tLower = t.toLowerCase()
        const tWords = tLower.split(' ').filter(w => w.length > 2)
        for (const a of document.querySelectorAll('a')) {
          const text = (a.innerText || a.title || '').toLowerCase()
          const href = a.href || ''
          const matched = tWords.filter(w => text.includes(w)).length / tWords.length
          if (matched >= 0.5) {
            if (isEpisode && href.includes('/series/')) return href
            if (!isEpisode && !href.includes('/series/') && !href.includes('/category/')) return href
          }
        }
        return null
      }, title, Boolean(seasonNum))

      if (!resultUrl) {
        log.warn(`[topcinema] ما لقى رابط في صفحة البحث: "${title}"`)
        await context.close()
        return []
      }
      log.info(`[topcinema] وجد: ${resultUrl}`)

      let targetUrl = resultUrl

      if (seasonNum && episodeNum) {
        await page.goto(resultUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
        await wait(800)
        const episodeUrl = await page.evaluate((sNum, eNum) => {
          for (const a of document.querySelectorAll('a')) {
            const text = (a.innerText || '').toLowerCase()
            const href = a.href || ''
            const hasEp = text.includes(`الحلقة ${eNum}`) || text.includes(`episode ${eNum}`) || text.includes(`e${String(eNum).padStart(2,'0')}`)
            const hasSn = text.includes(`الموسم ${sNum}`) || text.includes(`season ${sNum}`) || sNum === 1
            if (hasEp && hasSn) return href
          }
          return null
        }, seasonNum, episodeNum)
        if (!episodeUrl) {
          log.warn(`[topcinema] ما لقى الحلقة S${seasonNum}E${episodeNum}`)
          await context.close()
          return []
        }
        targetUrl = episodeUrl
      }

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
      await wait(800)

      const watchUrl = await page.evaluate(() =>
        document.querySelector('a.watch, a[href*="/watch/"]')?.href || null
      )
      if (watchUrl) {
        await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
        await wait(800)
      }

      await extractEmbeds(page, embedMap)
      await clickAllServers(page, embedMap)
      await wait(CONFIG.waitAfterAll)
    }

    // ── faselhd ──
    if (source.type === 'faselhd') {
      const resultUrl = await page.evaluate((t, isEpisode) => {
        const tLower = t.toLowerCase()
        const tWords = tLower.split(' ').filter(w => w.length > 2)
        for (const a of document.querySelectorAll('a.postDiv, .postDiv a, .postInner a, a[href*="/movies/"], a[href*="/series/"]')) {
          const text = (a.innerText || a.querySelector?.('.h1')?.innerText || '').toLowerCase()
          const href = a.href || ''
          if (!href || href === '#') continue
          const matched = tWords.filter(w => text.includes(w)).length / tWords.length
          if (matched >= 0.5) {
            if (isEpisode && href.includes('/series/')) return href
            if (!isEpisode && href.includes('/movies/')) return href
          }
        }
        return null
      }, title, Boolean(seasonNum))

      if (!resultUrl) {
        log.warn(`[faselhd] ما لقى رابط في صفحة البحث: "${title}"`)
        await context.close()
        return []
      }
      log.info(`[faselhd] وجد: ${resultUrl}`)

      let targetUrl = resultUrl

      if (seasonNum && episodeNum) {
        await page.goto(resultUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
        await wait(800)
        const episodeUrl = await page.evaluate((sNum, eNum) => {
          for (const a of document.querySelectorAll('a')) {
            const text = (a.innerText || '').toLowerCase()
            const href = a.href || ''
            const hasEp = text.includes(`الحلقة ${eNum}`) || text.includes(`episode ${eNum}`)
            const hasSn = text.includes(`الموسم ${sNum}`) || text.includes(`season ${sNum}`) || sNum === 1
            if (hasEp && hasSn) return href
          }
          return null
        }, seasonNum, episodeNum)
        if (!episodeUrl) {
          log.warn(`[faselhd] ما لقى الحلقة S${seasonNum}E${episodeNum}`)
          await context.close()
          return []
        }
        targetUrl = episodeUrl
      }

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
      await wait(800)

      const serverItems = await page.$$('li[onclick*="player_iframe"]')
      
log.info(`[faselhd] ${serverItems.length} سيرفر وجدنا`)
      log.info(`[faselhd] ${serverItems.length} سيرفر في الصفحة`)
      for (const item of serverItems) {
        try {
          await item.click()
          await wait(CONFIG.waitAfterClick)
        } catch {}
      }
      await wait(CONFIG.waitAfterAll)
    }

    const results = [...m3u8Map.values()]
    if (results.length) {
      log.success(`[${source.name}] ${results.length} m3u8 <- ${title}`)
    } else {
      log.warn(`[${source.name}] وجد الصفحة لكن ما طلع m3u8: "${title}"`)
    }

    await context.close()
    return results

  } catch (e) {
    log.error(`[${source.name}] فشل: ${title} | ${e.message}`)
    await context.close()
    return []
  }
}

async function updateServersInSupabase(titleId, episodeId, m3u8Results) {
  if (!m3u8Results.length) return

  const q = supabase
    .from('servers')
    .select('id, server_name')
    .eq('title_id', titleId)
    .eq('is_embed', false)

  if (episodeId) q.eq('episode_id', episodeId)
  else q.is('episode_id', null)

  const { data: existing } = await q

  for (let i = 0; i < m3u8Results.length; i++) {
    const newUrl = m3u8Results[i].url
    if (existing && existing[i]) {
      await supabase.from('servers')
        .update({ server_url: newUrl, updated_at: new Date().toISOString() })
        .eq('id', existing[i].id)
    } else {
      await supabase.from('servers').insert({
        title_id:    titleId,
        episode_id:  episodeId || null,
        server_name: `HLS ${i + 1}`,
        server_url:  newUrl,
        quality:     '1080p',
        language:    'ar',
        is_embed:    false,
        is_active:   true,
        sort_order:  i,
      })
    }
  }
}

async function refreshTitle(browser, titleId, episodeId = null) {
  const { data: title } = await supabase
    .from('titles')
    .select('id, original_title, year, type')
    .eq('id', titleId)
    .single()

  if (!title) return false

  let seasonNum = null, episodeNum = null
  if (episodeId) {
    const { data: ep } = await supabase
      .from('episodes')
      .select('episode_number, seasons(season_number)')
      .eq('id', episodeId)
      .single()
    if (ep) {
      episodeNum = ep.episode_number
      seasonNum  = ep.seasons?.season_number
    }
  }

  log.title(`${title.original_title} (${title.year})${episodeId ? ` S${seasonNum}E${episodeNum}` : ''}`)

  const serverQ = supabase
    .from('servers')
    .select('id, server_url')
    .eq('title_id', titleId)
    .eq('is_active', true)
    .eq('is_embed', false)

  if (episodeId) serverQ.eq('episode_id', episodeId)
  else serverQ.is('episode_id', null)

  const { data: existing } = await serverQ

  if (existing?.length > 0 && existing.every(s => !isTokenExpired(s.server_url))) {
    log.success(`شغال — لا تحديث`)
    return true
  }

  let allResults = []
 // أولاً faselhd
const results = await searchFaselHD(title.original_title, title.year, seasonNum, episodeNum)
allResults = [...allResults, ...results]

// لو ما لقينا شيء جرب topcinema
if (allResults.length === 0) {
  for (const source of CONFIG.sources.filter(s => s.type === 'topcinema')) {
    const r = await searchInSource(browser, source, title.original_title, title.year, seasonNum, episodeNum)
    allResults = [...allResults, ...r]
  }
}

  if (!allResults.length) {
    log.warn(`ما لقينا في كل المصادر: ${title.original_title}`)
    return false
  }
log.info(`[debug] allResults: ${JSON.stringify(allResults)}`)
await updateServersInSupabase(titleId, episodeId, allResults)
  await updateServersInSupabase(titleId, episodeId, allResults)
  return true
}

async function runScheduledCheck() {
  const startTime = Date.now()
  log.info('بدء الفحص الذكي...')

  const expiredServers = await getExpiredServers()
  if (!expiredServers.length) {
    log.success('كل الروابط شغالة')
    return
  }

  const groups = groupExpiredByTitle(expiredServers)
  const sorted = sortByYear(groups)

  log.info(`${sorted.length} عنوان يحتاج تحديث`)

const path = require('path')

const browser = await puppeteer.launch({
  headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  userDataDir: path.join(__dirname, 'puppeteer-profile'),
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
})

  for (let i = 0; i < sorted.length; i += CONFIG.batchSize) {
    const batch = sorted.slice(i, i + CONFIG.batchSize)
    for (const g of batch) {
  await refreshTitle(browser, g.title_id, g.episode_id).catch(e =>
    log.error(`فشل: ${g.title?.original_title} | ${e.message}`)
  )
}
    log.info(`تم ${Math.min(i + CONFIG.batchSize, sorted.length)}/${sorted.length}`)
  }

  await browser.close()

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  log.success(`انتهى في ${elapsed} ثانية`)
}

module.exports = { refreshTitle, runScheduledCheck }