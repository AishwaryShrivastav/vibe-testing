const analyticsEndpoint = document.querySelector('meta[name="analytics-endpoint"]')?.content?.trim()

function track(event, properties = {}) {
  const detail = { event, properties, path: location.pathname, timestamp: new Date().toISOString() }
  window.dispatchEvent(new CustomEvent('vibe:analytics', { detail }))

  try {
    const counts = JSON.parse(localStorage.getItem('vibe_site_events') || '{}')
    counts[event] = (counts[event] || 0) + 1
    localStorage.setItem('vibe_site_events', JSON.stringify(counts))
  } catch {}

  if (analyticsEndpoint) {
    navigator.sendBeacon(analyticsEndpoint, new Blob([JSON.stringify(detail)], { type: 'application/json' }))
  }
}

document.querySelectorAll('[data-event]').forEach(element => {
  element.addEventListener('click', () => track(element.dataset.event, { href: element.getAttribute('href') || undefined }))
})

document.querySelectorAll('[data-copy-command]').forEach(button => {
  button.addEventListener('click', async () => {
    const block = button.closest('[data-command-block]')
    const command = block?.querySelector('code')?.textContent?.trim()
    if (!command) return

    const label = button.querySelector('[data-copy-label]')
    try {
      await navigator.clipboard.writeText(command)
      if (label) label.textContent = 'Copied'
      track(button.dataset.event || 'copy_command', { command })
      window.setTimeout(() => { if (label) label.textContent = 'Copy' }, 1800)
    } catch {
      if (label) label.textContent = 'Select text'
    }
  })
})

const runButtons = document.querySelectorAll('[data-run]')
const verdict = document.querySelector('[data-verdict]')
const regressionRow = document.querySelector('[data-regression-row]')
const regressionCopy = document.querySelector('[data-regression-copy]')

runButtons.forEach(button => {
  button.addEventListener('click', () => {
    runButtons.forEach(candidate => {
      const active = candidate === button
      candidate.classList.toggle('active', active)
      candidate.setAttribute('aria-pressed', String(active))
    })

    const current = button.dataset.run === 'current'
    verdict?.classList.toggle('ready', !current)
    const verdictText = verdict?.querySelector('strong')
    const verdictStamp = verdict?.querySelector('.verdict-stamp')
    if (verdictText) verdictText.textContent = current ? 'BLOCKED' : 'READY'
    if (verdictStamp) verdictStamp.textContent = current ? '1 regression' : '8 checks passed'
    regressionRow?.classList.toggle('hidden', !current)
    if (regressionCopy) regressionCopy.textContent = 'payment request returned 500'
    track('report_run_switch', { run: button.dataset.run })
  })
})
