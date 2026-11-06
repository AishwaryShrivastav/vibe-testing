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
