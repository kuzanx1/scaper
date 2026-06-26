// src/runScheduledCheck.js
require('dotenv').config()

const { log, CONFIG, sortByYear, groupExpiredByTitle } = require('./config')
const { createRunReporter } = require('./reporter')
const { getExpiredServers, refreshTitle, launchMainBrowser } = require('./resolver')

async function runScheduledCheck() {
  const startTime = Date.now()
  const reporter = createRunReporter()

  log.info('بدء الفحص الذكي...')

  const expiredServers = await getExpiredServers()

  if (!expiredServers.length) {
    reporter.finish()
    log.success('كل الروابط شغالة')
    return
  }

  const groups = groupExpiredByTitle(expiredServers)
  const sorted = sortByYear(groups)

  log.info(`${sorted.length} عنوان يحتاج تحديث`)

  const browser = await launchMainBrowser()

  try {
    for (let i = 0; i < sorted.length; i += CONFIG.batchSize) {
      const batch = sorted.slice(i, i + CONFIG.batchSize)

      await Promise.all(
        batch.map(g =>
          refreshTitle(browser, g.title_id, g.episode_id, reporter).catch(e => {
            reporter.pushJob({
              titleId: g.title_id,
              episodeId: g.episode_id,
              title: g.title?.original_title || 'Unknown',
              year: g.title?.year || null,
              status: 'failed',
              source: null,
              reason: `unexpected_batch_error: ${e.message}`,
              hlsCount: 0,
            })

            log.error(`فشل: ${g.title?.original_title} | ${e.message}`)
          })
        )
      )

      log.info(`تم ${Math.min(i + CONFIG.batchSize, sorted.length)}/${sorted.length}`)
    }
  } finally {
    await browser.close()
    reporter.finish()
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  log.success(`انتهى في ${elapsed} ثانية`)
}

module.exports = { runScheduledCheck }

if (require.main === module) {
  runScheduledCheck().catch(err => {
    console.error(err)
    process.exit(1)
  })
}