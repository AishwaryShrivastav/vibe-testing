import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyCreatedValues } from '../src/engine/browser/form-checks.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

/**
 * Admin-style screens with no <form>: inputs plus a Create button wired by
 * script. `shows` decides whether the new row is rendered after creating.
 */
function roomScreen(shows: boolean): string {
  return page(`
    <h1>Rooms</h1>
    <ul id="rooms"><li>101</li></ul>
    <div class="room-form">
      <div><input id="roomName" data-testid="roomName"></div>
      <div><input id="roomPrice" data-testid="roomPrice"></div>
      <div><button id="createRoom">Create</button></div>
    </div>
    <script>
      document.getElementById('createRoom').onclick = () => {
        const name = document.getElementById('roomName')
        const price = document.getElementById('roomPrice')
        if (!name.value || !price.value) return
        if (${shows}) {
          const li = document.createElement('li')
          li.textContent = name.value + ' £' + price.value
          document.getElementById('rooms').appendChild(li)
        }
        name.value = ''
        price.value = ''
      }
    </script>`)
}

/** A search toolbar: its button isn't a create action, so it is never judged. */
const TOOLBAR = page(`
  <div class="toolbar"><input placeholder="Search rooms"><button>Go</button></div>
  <script>document.querySelector('button').onclick = () => { document.querySelector('input').value = '' }</script>`)

/** Two action buttons in one group: the intent is unclear, so it is not judged. */
const TWO_ACTIONS = page(`
  <div class="editor"><input id="title"><button>Save</button><button>Add</button></div>
  <script>document.querySelectorAll('button').forEach(b => b.onclick = () => { document.getElementById('title').value = '' })</script>`)

describe('create-then-verify: input groups without a <form>', () => {
  let fx: BrowserFixture

  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/bad': roomScreen(false),
      '/good': roomScreen(true),
      '/toolbar': TOOLBAR,
      '/two': TWO_ACTIONS,
    })
  })
  afterAll(async () => { await fx?.close() })

  async function check(route: string) {
    const tab = await fx.browser.newPage()
    try {
      return await verifyCreatedValues(tab, `${fx.baseUrl}${route}`)
    } finally {
      await tab.close()
    }
  }

  it('flags a Create button that clears the inputs but never shows the new item', async () => {
    const outcomes = await check('/bad')
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ elementType: 'form', action: 'create-then-verify', result: 'error' })
    expect(outcomes[0].details).toMatch(/^Submitted value not shown: the form accepted "vibe-\w+" in roomName/)
  }, 60000)

  it('passes when the new item is shown', async () => {
    const outcomes = await check('/good')
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].result).toBe('success')
  }, 60000)

  it('ignores groups whose button is not a create action, or that have two actions', async () => {
    expect(await check('/toolbar')).toEqual([])
    expect(await check('/two')).toEqual([])
  }, 60000)
})
