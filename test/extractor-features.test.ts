import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { extractBehaviours } from '../src/engine/context/extractor.js'

async function featureTypes(source: string): Promise<string[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-features-'))
  const file = path.join(dir, 'Page.jsx')
  await fs.writeFile(file, source)
  try {
    const [b] = await extractBehaviours([{ path: '/x', type: 'page', requires_auth: false, dynamic_segments: [], file_path: file }], 'deep')
    return (b.functionality?.features ?? []).map(f => f.type)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('extractBehaviours → search/filter features need real search or tab code', () => {
  it('a server route list mentioning /research has no search or filter', async () => {
    const types = await featureTypes(`
      app.get("/research", isLoggedIn, researchHandler.displayResearch)
      app.get("/tutorial", (req, res) => res.render("tutorial/a1", { table: true, stable: 1 }))`)
    expect(types).not.toContain('search')
    expect(types).not.toContain('filter')
  })

  it('search state or a search input is a search feature', async () => {
    expect(await featureTypes(`const [searchTerm, setSearchTerm] = useState('')`)).toContain('search')
    expect(await featureTypes(`<input type="search" />`)).toContain('search')
    expect(await featureTypes(`<input placeholder="Search products" />`)).toContain('search')
  })

  it('tab or filter state is a filter feature', async () => {
    expect(await featureTypes(`const [activeTab, setActiveTab] = useState(0)`)).toContain('filter')
    expect(await featureTypes(`<div role="tablist"></div>`)).toContain('filter')
  })
})

describe('extractBehaviours → prose is not evidence of controls', () => {
  it('a privacy policy that mentions search terms, pagination and uploads has no interactive features', async () => {
    const types = await featureTypes(`
      export default function Privacy() {
        const [branding, setBranding] = useState(null)
        return (<div><h1>Privacy Policy Notice</h1>
          <p>We also track frequently used search terms and selected keywords to prioritise content.</p>
          <p>Search engines may index this page. Use filters in your browser; pagination of the log is not stored.</p>
          <p>Do not upload personal data; any file you upload is deleted.</p></div>)
      }`)
    expect(types).not.toContain('search')
    expect(types).not.toContain('filter')
    expect(types).not.toContain('pagination')
    expect(types).not.toContain('upload')
  })

  it('real pagination and file inputs are still detected', async () => {
    expect(await featureTypes(`const [page, setPage] = useState(1)`)).toContain('pagination')
    expect(await featureTypes(`<input type="file" />`)).toContain('upload')
  })
})
