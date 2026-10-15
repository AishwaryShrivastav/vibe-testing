const PACKAGE = 'vibe-testing'
const FIRST_PUBLISHED = '2026-04-16'
const API = 'https://api.npmjs.org/downloads/point'

function validDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
}

async function readJson(fetcher, url) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error('npm download data unavailable')
  return response.json()
}

export async function getNpmDownloads(fetcher = fetch) {
  // The relative window ends on npm's latest reported day. A request through
  // today's date can include unreported days with zero downloads.
  const latest = await readJson(fetcher, `${API}/last-week/${PACKAGE}`)
  if (latest.package !== PACKAGE || !validDay(latest.end) || latest.end < FIRST_PUBLISHED ||
      latest.end > new Date().toISOString().slice(0, 10)) {
    throw new Error('Invalid npm reporting date')
  }

  const total = await readJson(fetcher, `${API}/${FIRST_PUBLISHED}:${latest.end}/${PACKAGE}`)
  if (total.package !== PACKAGE || total.start !== FIRST_PUBLISHED || total.end !== latest.end ||
      !Number.isSafeInteger(total.downloads) || total.downloads < 0) {
    throw new Error('Invalid npm download count')
  }
  return { count: total.downloads, through: total.end }
}

export async function refreshNpmDownloads(root = document, fetcher = fetch) {
  const count = root.querySelector('[data-npm-downloads]')
  const date = root.querySelector('[data-npm-date]')
  if (!count || !date) return

  try {
    const result = await getNpmDownloads(fetcher)
    count.textContent = result.count.toLocaleString('en-US')
    date.textContent = `through ${new Date(`${result.through}T12:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
    })}`
  } catch {
    // The dated count in the HTML remains visible when npm or the network fails.
  }
}

if (typeof document !== 'undefined') refreshNpmDownloads()
