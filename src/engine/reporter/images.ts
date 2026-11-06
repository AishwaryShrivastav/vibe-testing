import fs from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'

/** A screenshot as the report shows it: a small embedded thumbnail plus a link to the full image. */
export interface ReportImage {
  /** Embedded JPEG thumbnail (data URL), when one could be made. */
  thumb?: string
  /** Where the full-size screenshot lives: relative to the report when possible, else a file:// URL. */
  full: string
}

export interface ThumbnailSize {
  /** Thumbnail width in pixels. */
  width: number
  /** Tall (full-page) screenshots are cropped to this height after scaling, keeping the top. */
  maxHeight: number
}

/** Page and scenario screenshots. */
export const PAGE_THUMB: ThumbnailSize = { width: 480, maxHeight: 600 }
/** Per-step screenshots in step tables. */
export const STEP_THUMB: ThumbnailSize = { width: 200, maxHeight: 130 }

const JPEG_QUALITY = 0.6

/**
 * Make report images for screenshots on disk. Full-size files stay where they
 * are and are linked (relative to `reportDir` when they sit under it, so the
 * report works when opened from .vibe/); only a small JPEG thumbnail is
 * embedded, which keeps reports at a few hundred KB instead of tens of MB.
 *
 * Thumbnails are rendered with Playwright's Chromium (already a dependency).
 * If it can't start, images fall back to the linked full-size files.
 */
export async function prepareReportImages(
  requests: Array<{ path: string; size: ThumbnailSize }>,
  reportDir?: string,
): Promise<Map<string, ReportImage>> {
  const images = new Map<string, ReportImage>()
  const unique = new Map<string, ThumbnailSize>()
  for (const { path: file, size } of requests) {
    if (!unique.has(file)) unique.set(file, size)
  }

  const existing: Array<[string, ThumbnailSize]> = []
  for (const [file, size] of unique) {
    try {
      await fs.access(file)
      existing.push([file, size])
      images.set(file, { full: fullImageHref(file, reportDir) })
    } catch { /* missing screenshot: nothing to show */ }
  }
  if (existing.length === 0) return images

  let browser: { newPage: () => Promise<any>; close: () => Promise<void> } | undefined
  try {
    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    for (const [file, size] of existing) {
      try {
        const buffer = await fs.readFile(file)
        const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png'
        const thumb = await page.evaluate(downscale, {
          src: `data:${mime};base64,${buffer.toString('base64')}`,
          width: size.width,
          maxHeight: size.maxHeight,
          quality: JPEG_QUALITY,
        }) as string | undefined
        if (thumb) images.get(file)!.thumb = thumb
      } catch { /* this one stays link-only */ }
    }
  } catch {
    /* no browser: every image is link-only */
  } finally {
    await browser?.close().catch(() => {})
  }
  return images
}

/** Runs in the browser: scale an image to `width`, crop to `maxHeight`, return a JPEG data URL. */
async function downscale({ src, width, maxHeight, quality }: { src: string; width: number; maxHeight: number; quality: number }): Promise<string | undefined> {
  const img = new Image()
  img.src = src
  await img.decode()
  if (!img.naturalWidth) return undefined
  const scale = Math.min(1, width / img.naturalWidth)
  const w = Math.round(img.naturalWidth * scale)
  const h = Math.min(Math.round(img.naturalHeight * scale), maxHeight)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, img.naturalWidth * scale, img.naturalHeight * scale)
  return canvas.toDataURL('image/jpeg', quality)
}

/** Link to a screenshot: relative to the report when it sits under the report's folder, else file://. */
export function fullImageHref(file: string, reportDir?: string): string {
  const absolute = path.resolve(file)
  if (reportDir) {
    const relative = path.relative(path.resolve(reportDir), absolute)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative.split(path.sep).map(encodeURIComponent).join('/')
    }
  }
  return pathToFileURL(absolute).href
}
