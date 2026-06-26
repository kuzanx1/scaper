// src/config.js
const path = require('path')

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

  pageTimeout: 20000,
  waitAfterClick: 3000,
  waitAfterAll: 2000,
  tokenExpiryBuffer: 2 * 60 * 60,
  batchSize: 30,

  paths: {
    puppeteerProfile: path.join(__dirname, '..', 'puppeteer-profile'),
    faselhdProfile: 'C:\\Users\\N\\folim-scraper\\faselhd-profile',
    reportsDir: path.join(__dirname, '..', 'reports'),
  },
}

const log = {
  info: (msg) => console.log(`\x1b[36mi  ${msg}\x1b[0m`),
  success: (msg) => console.log(`\x1b[32m✅ ${msg}\x1b[0m`),
  warn: (msg) => console.log(`\x1b[33m⚠  ${msg}\x1b[0m`),
  error: (msg) => console.log(`\x1b[31m❌ ${msg}\x1b[0m`),
  title: (msg) => console.log(`\x1b[35m🎬 ${msg}\x1b[0m`),
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

function isTokenExpired(url) {
  if (!url || !url.includes('.m3u8')) return true
  const match = url.match(/[?&]e=(\d+)/)
  if (!match) return false
  const expiry = parseInt(match[1], 10)
  const nowSec = Math.floor(Date.now() / 1000)
  return expiry - nowSec < CONFIG.tokenExpiryBuffer
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

function sortByYear(items) {
  return [...items].sort((a, b) => {
    const ya = parseInt(a.title?.year) || 0
    const yb = parseInt(b.title?.year) || 0
    return yb - ya
  })
}

function groupExpiredByTitle(expiredServers) {
  const map = new Map()
  for (const s of expiredServers) {
    const key = `${s.title_id}::${s.episode_id || 'null'}`
    if (!map.has(key)) {
      map.set(key, {
        title_id: s.title_id,
        episode_id: s.episode_id,
        title: s.titles,
        servers: [],
      })
    }
    map.get(key).servers.push(s)
  }
  return [...map.values()]
}

module.exports = {
  CONFIG,
  log,
  wait,
  isTokenExpired,
  isBlocked,
  isEmbedDomain,
  cleanTitleForSearch,
  sortByYear,
  groupExpiredByTitle,
}