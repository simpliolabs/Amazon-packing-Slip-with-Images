export interface PerDesignGroup {
  designKey: string; designName: string; skus: string[]
  title: string; bullets: string[]; description: string
}
type TitleE = { sku: string; asin: string; title: string; designName?: string | null; designKey?: string | null }
type BulletE = { sku: string; asin: string; bullets: string[]; designKey?: string | null }
type DescE  = { sku: string; asin: string; description: string; designKey?: string | null }

/** Multi-DESIGN iff >=2 distinct designKeys among per-child titles. (designName can resolve empty
 *  for a real group, so it is NOT a reliable discriminator — capacity families have no designKey.) */
export function isMultiDesign(titles?: TitleE[] | null): boolean {
  if (!Array.isArray(titles)) return false
  return new Set(titles.filter((t) => t.designKey).map((t) => t.designKey as string)).size >= 2
}

/** Cluster SKU-keyed entries into one group per designKey. All SKUs of a design share content,
 *  so the first entry is representative. designName falls back to designKey when empty so a
 *  name-resolution miss never hides a real design. bullets/description may be empty (absent set);
 *  the caller falls back to the broadcast recommended_* in that case. */
export function groupByDesign(titles?: TitleE[] | null, bullets?: BulletE[] | null, descriptions?: DescE[] | null): PerDesignGroup[] {
  const t = Array.isArray(titles) ? titles : []
  const bulletsBySku = new Map((Array.isArray(bullets) ? bullets : []).map((x) => [x.sku, x.bullets]))
  const descBySku = new Map((Array.isArray(descriptions) ? descriptions : []).map((x) => [x.sku, x.description]))
  const order: string[] = []
  const groups = new Map<string, PerDesignGroup>()
  for (const e of t) {
    const key = e.designKey || ''
    if (!key) continue // capacity/single/broadcast entry — no design
    let g = groups.get(key)
    if (!g) {
      g = { designKey: key, designName: e.designName || key, skus: [], title: e.title, bullets: bulletsBySku.get(e.sku) ?? [], description: descBySku.get(e.sku) ?? '' }
      groups.set(key, g); order.push(key)
    }
    g.skus.push(e.sku)
  }
  return order.map((k) => groups.get(k)!)
}
