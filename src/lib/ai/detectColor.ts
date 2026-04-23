/**
 * AI Color Detection
 * Uses GPT-4.1-mini vision to identify garment color from product images.
 * Returns an exact catalog color name or null on failure.
 */
import OpenAI from 'openai'
import { getCatalogColors } from './colorCatalogs'

const OPENAI_TIMEOUT_MS = 15_000

/**
 * Detect the color of a garment from its product image.
 *
 * @param imageUrl - Public URL of the product image
 * @param sku - Product SKU (used to determine catalog)
 * @param title - Product title (used to determine catalog)
 * @returns The detected catalog color name, or null if detection fails
 */
export async function detectColor(
  imageUrl: string,
  sku: string,
  title: string
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.warn('[AI Color] OPENAI_API_KEY not set, skipping detection')
    return null
  }

  try {
    const catalogColors = getCatalogColors(sku, title)
    const colorList = catalogColors.join(', ')

    const client = new OpenAI({
      apiKey,
      timeout: OPENAI_TIMEOUT_MS,
    })

    const response = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      max_tokens: 50,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are a garment color identification expert. You identify the exact catalog color of clothing items from product images. Respond with ONLY the color name, nothing else. No punctuation, no explanation.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
                detail: 'low', // low detail is sufficient for color and saves tokens
              },
            },
            {
              type: 'text',
              text: `What color is this garment? Choose ONLY from this list:\n${colorList}\n\nRespond with the exact color name from the list above.`,
            },
          ],
        },
      ],
    })

    const detected = response.choices?.[0]?.message?.content?.trim() || null

    if (!detected) {
      console.warn(`[AI Color] Empty response for SKU ${sku}`)
      return null
    }

    // Validate the response is actually in our catalog
    const match = catalogColors.find(
      (c) => c.toLowerCase() === detected.toLowerCase()
    )

    if (!match) {
      console.warn(
        `[AI Color] Response "${detected}" not in catalog for SKU ${sku}. Attempting fuzzy match.`
      )
      // Try partial match as fallback
      const fuzzy = catalogColors.find(
        (c) =>
          c.toLowerCase().includes(detected.toLowerCase()) ||
          detected.toLowerCase().includes(c.toLowerCase())
      )
      if (fuzzy) {
        console.log(`[AI Color] Fuzzy matched "${detected}" → "${fuzzy}" for SKU ${sku}`)
        return fuzzy
      }
      return null
    }

    console.log(`[AI Color] Detected "${match}" for SKU ${sku}`)
    return match
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    console.warn(`[AI Color] Detection failed for SKU ${sku}: ${msg}`)
    return null
  }
}

/**
 * Batch detect colors for multiple items.
 * Processes items sequentially to avoid rate limits.
 * Skips items that already have ai_detected_color set.
 *
 * @param items - Array of order items with image URLs
 * @returns The same items array with ai_detected_color populated where possible
 */
export async function batchDetectColors(
  items: Array<{
    asin: string
    sku: string
    title: string
    image_url: string | null
    ai_detected_color?: string | null
  }>
): Promise<typeof items> {
  // Track detected colors by ASIN to avoid duplicate API calls
  // for the same product across different orders
  const asinColorCache = new Map<string, string | null>()

  for (const item of items) {
    // Skip if already detected
    if (item.ai_detected_color) continue

    // Skip if no image
    if (!item.image_url) continue

    // Check cache first (same product in multiple items)
    if (asinColorCache.has(item.asin)) {
      item.ai_detected_color = asinColorCache.get(item.asin) || undefined
      continue
    }

    const color = await detectColor(item.image_url, item.sku, item.title)
    asinColorCache.set(item.asin, color)

    if (color) {
      item.ai_detected_color = color
    }
  }

  return items
}
