// src/resolver.js
require('dotenv').config()

const path = require('path')
const { chromium } = require('playwright')
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const { createClient } = require('@supabase/supabase-js')

const {
  CONFIG,
  log,
  wait,
  isTokenExpired,
  isBlocked,
  isEmbedDomain,
  cleanTitleForSearch,
} = require('./config')

puppeteer.use(StealthPlugin())

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

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

function setupM3u8Interceptor(page, m3u8Map) {
  page.on('response', async (response) => {
    try {
      const url = response.url()
      const status = response.status()
      if (
        url.includes('.m3u8') &&
        !url.includes('index-v1-a1.m3u8') &&
        !url.includes('.ts') &&
        status >= 200 &&
        status < 400 &&
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
      if (isEmbedDomain(src) && !isBlocked(src)) {
        embedMap.set(src, { url: src })
      }
    }
  } catch {}
}

async function clickAllServers(page, embedMap, m3u8Map, selector) {
  const buttons = await page.$$(selector)
  if (!buttons.length) return 0

  log.info(`${buttons.length} سيرفر`)

  for (const btn of buttons) {
    try {
      const beforeCount = m3u8Map.size
      await btn.click()
      await wait(CONFIG.waitAfterClick)
      await extractEmbeds(page, embedMap)
      await wait(CONFIG.waitAfterAll)

      if (m3u8Map.size === beforeCount) {
        await wait(1500)
      }
    } catch {}
  }

  return buttons.length
}

async function searchTopCinema(browser, title, year, seasonNum, episodeNum) {
  const startedAt = Date.now()
  const source = CONFIG.sources.find(s => s.type === 'topcinema')
  const query = cleanTitleForSearch(title, year)
  const searchUrl = source.searchUrl.replace('{query}', encodeURIComponent(query))

  log.info(`[topcinema] يبحث عن: "${title}"`)

  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  const m3u8Map = new Map()
  const embedMap = new Map()

  await page.setRequestInterception(true)
  page.on('request', req => {
    const t = req.resourceType()
    if (
      isBlocked(req.url()) ||
      t === 'font' ||
      t === 'stylesheet' ||
      t === 'image' ||
      t === 'media'
    ) return req.abort()
    req.continue()
  })

  setupM3u8Interceptor(page, m3u8Map)
  await page.evaluateOnNewDocument(() => { window.open = () => null })
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36')

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
    await wait(1000)

    const resultUrl = await page.evaluate((t, isEpisode) => {
      const tLower = t.toLowerCase()
      const tWords = tLower.split(' ').filter(w => w.length > 2)

      for (const a of document.querySelectorAll('a')) {
        const text = (a.innerText || a.title || '').toLowerCase()
        const href = a.href || ''
        const matched = tWords.length
          ? tWords.filter(w => text.includes(w)).length / tWords.length
          : 0

        if (matched >= 0.5) {
          if (isEpisode && href.includes('/series/')) return href
          if (!isEpisode && !href.includes('/series/') && !href.includes('/category/')) return href
        }
      }

      return null
    }, title, Boolean(seasonNum))

    if (!resultUrl) {
      await context.close()
      return {
        source: 'topcinema',
        status: 'source_not_found',
        reason: 'لم يتم العثور على نتيجة مطابقة في صفحة البحث',
        matchedUrl: null,
        hlsUrls: [],
        hlsCount: 0,
        elapsedMs: Date.now() - startedAt,
      }
    }

    let targetUrl = resultUrl

    if (seasonNum && episodeNum) {
      await page.goto(resultUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
      await wait(800)

      const episodeUrl = await page.evaluate((sNum, eNum) => {
        for (const a of document.querySelectorAll('a')) {
          const text = (a.innerText || '').toLowerCase()
          const href = a.href || ''
          const hasEp =
            text.includes(`الحلقة ${eNum}`) ||
            text.includes(`episode ${eNum}`) ||
            text.includes(`e${String(eNum).padStart(2, '0')}`)
          const hasSn =
            text.includes(`الموسم ${sNum}`) ||
            text.includes(`season ${sNum}`) ||
            sNum === 1

          if (hasEp && hasSn) return href
        }
        return null
      }, seasonNum, episodeNum)

      if (!episodeUrl) {
        await context.close()
        return {
          source: 'topcinema',
          status: 'source_not_found',
          reason: `لم يتم العثور على الحلقة S${seasonNum}E${episodeNum}`,
          matchedUrl: resultUrl,
          hlsUrls: [],
          hlsCount: 0,
          elapsedMs: Date.now() - startedAt,
        }
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
    await clickAllServers(page, embedMap, m3u8Map, 'li.server--item')
    await wait(CONFIG.waitAfterAll)

    const results = [...m3u8Map.values()]
    await context.close()

    if (!results.length) {
      return {
        source: 'topcinema',
        status: 'page_loaded_no_hls',
        reason: 'تم فتح الصفحة ولكن لم يظهر أي رابط HLS',
        matchedUrl: targetUrl,
        watchUrl: watchUrl || null,
        hlsUrls: [],
        hlsCount: 0,
        elapsedMs: Date.now() - startedAt,
      }
    }

    return {
      source: 'topcinema',
      status: 'success',
      reason: null,
      matchedUrl: targetUrl,
      watchUrl: watchUrl || null,
      hlsUrls: results.map(r => r.url),
      hlsCount: results.length,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (e) {
    await context.close()
    return {
      source: 'topcinema',
      status: 'unexpected_error',
      reason: e.message,
      matchedUrl: null,
      hlsUrls: [],
      hlsCount: 0,
      elapsedMs: Date.now() - startedAt,
    }
  }
}

async function searchFaselHD(title, year, seasonNum, episodeNum) {
  const startedAt = Date.now()
  const query = cleanTitleForSearch(title, year)
  const searchUrl = `https://web62118xx.faselhdx.xyz/?s=${encodeURIComponent(query)}`

  log.info(`[faselhd] يبحث عن: "${title}"`)

  const context = await chromium.launchPersistentContext(CONFIG.paths.faselhdProfile, {
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  })

  const page = await context.newPage()
  const m3u8Map = new Map()

  page.on('response', async (response) => {
    try {
      const url = response.url()
      if (
        url.includes('.m3u8') &&
        !url.includes('index-v1-a1.m3u8') &&
        response.status() >= 200 &&
        response.status() < 400
      ) {
        const key = url.split('?')[0]
        if (!m3u8Map.has(key)) m3u8Map.set(key, { url })
      }
    } catch {}
  })

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(2000)

    const hasCloudflare =
      await page.locator('text=Cloudflare').count().catch(() => 0)

    const challengeDetected = hasCloudflare || page.url().toLowerCase().includes('challenge')

    if (challengeDetected) {
      await context.close()
      return {
        source: 'faselhd',
        status: 'challenge_blocked',
        reason: 'ظهر Cloudflare challenge والجلسة الحالية لم تتجاوزه',
        matchedUrl: page.url(),
        hlsUrls: [],
        hlsCount: 0,
        elapsedMs: Date.now() - startedAt,
      }
    }

    const resultUrl = await page.evaluate((t, isEpisode) => {
      const tLower = t.toLowerCase()
      const tWords = tLower.split(' ').filter(w => w.length > 2)

      for (const a of document.querySelectorAll('a[href*="/movies/"], a[href*="/series/"]')) {
        const text = (a.innerText || '').toLowerCase()
        const href = a.href || ''
        if (!href) continue

        const matched = tWords.length
          ? tWords.filter(w => text.includes(w)).length / tWords.length
          : 0

        if (matched >= 0.5) {
          if (isEpisode && href.includes('/series/')) return href
          if (!isEpisode && href.includes('/movies/')) return href
        }
      }

      return null
    }, title, Boolean(seasonNum))

    if (!resultUrl) {
      await context.close()
      return {
        source: 'faselhd',
        status: 'source_not_found',
        reason: 'لم يتم العثور على نتيجة مطابقة في فاصل',
        matchedUrl: null,
        hlsUrls: [],
        hlsCount: 0,
        elapsedMs: Date.now() - startedAt,
      }
    }

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
        await context.close()
        return {
          source: 'faselhd',
          status: 'source_not_found',
          reason: `لم يتم العثور على الحلقة S${seasonNum}E${episodeNum}`,
          matchedUrl: resultUrl,
          hlsUrls: [],
          hlsCount: 0,
          elapsedMs: Date.now() - startedAt,
        }
      }

      targetUrl = episodeUrl
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeout })
    await wait(800)

    const serverCount = await clickAllServers(page, new Map(), m3u8Map, 'li[onclick*="player_iframe"]')
    await wait(CONFIG.waitAfterAll)

    const results = [...m3u8Map.values()]
    await context.close()

    if (!results.length) {
      return {
        source: 'faselhd',
        status: 'page_loaded_no_hls',
        reason: serverCount > 0
          ? 'تم فتح الصفحة والضغط على السيرفرات لكن لم يظهر HLS'
          : 'تم فتح الصفحة لكن لم تظهر سيرفرات قابلة للاستخراج',
        matchedUrl: targetUrl,
        hlsUrls: [],
        hlsCount: 0,
        elapsedMs: Date.now() - startedAt,
      }
    }

    return {
      source: 'faselhd',
      status: 'success',
      reason: null,
      matchedUrl: targetUrl,
      hlsUrls: results.map(r => r.url),
      hlsCount: results.length,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (e) {
    await context.close()
    return {
      source: 'faselhd',
      status: 'unexpected_error',
      reason: e.message,
      matchedUrl: null,
      hlsUrls: [],
      hlsCount: 0,
      elapsedMs: Date.now() - startedAt,
    }
  }
}

async function updateServersInSupabase(titleId, episodeId, hlsUrls) {
  if (!hlsUrls.length) return { ok: false, reason: 'no_hls_urls' }

  let q = supabase
    .from('servers')
    .select('id, server_name')
    .eq('title_id', titleId)
    .eq('is_embed', false)

  if (episodeId) q = q.eq('episode_id', episodeId)
  else q = q.is('episode_id', null)

  const { data: existing, error } = await q

  if (error) {
    return { ok: false, reason: error.message }
  }

  for (let i = 0; i < hlsUrls.length; i++) {
    const newUrl = hlsUrls[i]

    if (existing && existing[i]) {
      const { error: updateError } = await supabase
        .from('servers')
        .update({ server_url: newUrl, updated_at: new Date().toISOString() })
        .eq('id', existing[i].id)

      if (updateError) return { ok: false, reason: updateError.message }
    } else {
      const { error: insertError } = await supabase.from('servers').insert({
        title_id: titleId,
        episode_id: episodeId || null,
        server_name: `HLS ${i + 1}`,
        server_url: newUrl,
        quality: '1080p',
        language: 'ar',
        is_embed: false,
        is_active: true,
        sort_order: i,
      })

      if (insertError) return { ok: false, reason: insertError.message }
    }
  }

  return { ok: true }
}

async function getTitleAndEpisode(titleId, episodeId = null) {
  const { data: title } = await supabase
    .from('titles')
    .select('id, original_title, year, type')
    .eq('id', titleId)
    .single()

  if (!title) return null

  let seasonNum = null
  let episodeNum = null

  if (episodeId) {
    const { data: ep } = await supabase
      .from('episodes')
      .select('episode_number, seasons(season_number)')
      .eq('id', episodeId)
      .single()

    if (ep) {
      episodeNum = ep.episode_number
      seasonNum = ep.seasons?.season_number
    }
  }

  return { title, seasonNum, episodeNum }
}

async function refreshTitle(browser, titleId, episodeId = null, reporter = null) {
  const meta = await getTitleAndEpisode(titleId, episodeId)
  if (!meta) {
    return { status: 'failed', reason: 'title_not_found' }
  }

  const { title, seasonNum, episodeNum } = meta

  log.title(`${title.original_title} (${title.year})${episodeId ? ` S${seasonNum}E${episodeNum}` : ''}`)

  let serverQ = supabase
    .from('servers')
    .select('id, server_url')
    .eq('title_id', titleId)
    .eq('is_active', true)
    .eq('is_embed', false)

  if (episodeId) serverQ = serverQ.eq('episode_id', episodeId)
  else serverQ = serverQ.is('episode_id', null)

  const { data: existing } = await serverQ

  if (existing?.length > 0 && existing.every(s => !isTokenExpired(s.server_url))) {
    reporter?.pushJob({
      titleId,
      episodeId,
      title: title.original_title,
      year: title.year,
      status: 'skipped',
      source: null,
      reason: 'all_existing_hls_still_valid',
      hlsCount: existing.length,
    })

    log.success('شغال — لا تحديث')
    return { status: 'skipped' }
  }

  const attempts = []

  const topResult = await searchTopCinema(browser, title.original_title, title.year, seasonNum, episodeNum)
  attempts.push(topResult)
  reporter?.appendAttempt({
    titleId,
    episodeId,
    title: title.original_title,
    year: title.year,
    source: topResult.source,
    status: topResult.status,
    reason: topResult.reason,
    matchedUrl: topResult.matchedUrl || null,
    hlsCount: topResult.hlsCount,
    elapsedMs: topResult.elapsedMs,
  })

  let finalResult = topResult

  if (topResult.status !== 'success') {
    const faselResult = await searchFaselHD(title.original_title, title.year, seasonNum, episodeNum)
    attempts.push(faselResult)
    reporter?.appendAttempt({
      titleId,
      episodeId,
      title: title.original_title,
      year: title.year,
      source: faselResult.source,
      status: faselResult.status,
      reason: faselResult.reason,
      matchedUrl: faselResult.matchedUrl || null,
      hlsCount: faselResult.hlsCount,
      elapsedMs: faselResult.elapsedMs,
    })

    if (faselResult.status === 'success') {
      finalResult = faselResult
    }
  }

  if (finalResult.status !== 'success') {
    reporter?.pushJob({
      titleId,
      episodeId,
      title: title.original_title,
      year: title.year,
      status: 'failed',
      source: finalResult.source,
      reason: finalResult.reason || finalResult.status,
      hlsCount: 0,
      attempts,
    })

    log.warn(`ما لقينا HLS: ${title.original_title}`)
    return { status: 'failed', reason: finalResult.reason, attempts }
  }

  const dbResult = await updateServersInSupabase(titleId, episodeId, finalResult.hlsUrls)

  if (!dbResult.ok) {
    reporter?.pushJob({
      titleId,
      episodeId,
      title: title.original_title,
      year: title.year,
      status: 'failed',
      source: finalResult.source,
      reason: `db_update_failed: ${dbResult.reason}`,
      hlsCount: finalResult.hlsCount,
      attempts,
    })

    return { status: 'failed', reason: dbResult.reason, attempts }
  }

  reporter?.pushJob({
    titleId,
    episodeId,
    title: title.original_title,
    year: title.year,
    status: 'success',
    source: finalResult.source,
    reason: null,
    hlsCount: finalResult.hlsCount,
    attempts,
  })

  return { status: 'success', source: finalResult.source, hlsCount: finalResult.hlsCount }
}

async function launchMainBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    userDataDir: CONFIG.paths.puppeteerProfile,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
}

module.exports = {
  supabase,
  getExpiredServers,
  refreshTitle,
  launchMainBrowser,
}