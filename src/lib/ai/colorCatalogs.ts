/**
 * Color Catalogs
 * Maps garment brand/style to their official catalog color names.
 * Used to constrain AI color detection to valid catalog options.
 *
 * Source: SS Activewear (ssactivewear.com)
 */

export const COMFORT_COLORS_1717: string[] = [
  'White', 'Black', 'Banana', 'Bay', 'Berry', 'Blossom', 'Blue Jean',
  'Blue Spruce', 'Brick', 'Bright Orange', 'Bright Salmon', 'Burnt Orange',
  'Butter', 'Candy Pink', 'Chambray', 'Chalky Mint', 'Chili', 'China Blue',
  'Citrus', 'Coral Silk', 'Crimson', 'Crunchberry', 'Denim', 'Dusk',
  'Emerald', 'Espresso', 'Faded Blue', 'Flo Blue', 'Gold', 'Granite',
  'Grape', 'Graphite', 'Grey', 'Hemp', 'Hydrangea', 'Ice Blue',
  'Island Green', 'Island Reef', 'Ivory', 'Khaki', 'Lagoon', 'Lavender',
  'Light Green', 'Melon', 'Midnight', 'Moss', 'Mustard', 'Mystic Blue',
  'Navy', 'Neon Cantaloupe', 'Neon Lemon', 'Neon Pink', 'Neon Red Orange',
  'Neon Violet', 'Old Gold', 'Orchid', 'Paprika', 'Peachy', 'Pepper',
  'Periwinkle', 'Pigment Black', 'Red', 'Red Orange', 'Rose Quartz',
  'Royal Caribe', 'Rust', 'Sage', 'Sandstone', 'Sapphire', 'Seafoam',
  'Smoke', 'Tan', 'Terracotta', 'True Navy', 'Vineyard', 'Violet',
  'Washed Denim', 'Watermelon', 'Wine', 'Yam',
]

export const BELLA_CANVAS_3001: string[] = [
  'White', 'Black', 'Ash', 'Athletic Heather', 'Autumn', 'Berry',
  'Black Heather', 'Brown', 'Burnt Orange', 'Canvas Red', 'Cardinal',
  'Charity Pink', 'Dark Grey', 'Dark Grey Heather', 'Deep Teal',
  'Forest', 'Gold', 'Heather Aqua', 'Heather Blue', 'Heather Clay',
  'Heather Columbia Blue', 'Heather Dark Grey', 'Heather Deep Teal',
  'Heather Dusty Blue', 'Heather Forest', 'Heather Grass Green',
  'Heather Mauve', 'Heather Midnight Navy', 'Heather Navy',
  'Heather Olive', 'Heather Orchid', 'Heather Peach', 'Heather Prism Dusty Blue',
  'Heather Prism Ice Blue', 'Heather Prism Lilac', 'Heather Prism Mint',
  'Heather Prism Natural', 'Heather Prism Peach', 'Heather Raspberry',
  'Heather Red', 'Heather Sage', 'Heather Sea Green', 'Heather Slate',
  'Heather Stone', 'Heather True Royal', 'Heather Yellow Gold',
  'Kelly', 'Lavender Dust', 'Leaf', 'Lilac', 'Maroon', 'Mauve',
  'Military Green', 'Natural', 'Navy', 'Ocean Blue', 'Olive',
  'Orange', 'Oxblood Black', 'Pebble', 'Pink', 'Purple', 'Red',
  'Silver', 'Soft Cream', 'Soft Pink', 'Steel Blue', 'Storm',
  'Tan', 'Team Purple', 'Teal', 'True Royal', 'Vintage White', 'Yellow',
]

export const GILDAN_64000: string[] = [
  'White', 'Black', 'Antique Cherry Red', 'Azalea', 'Carolina Blue',
  'Charcoal', 'Cherry Red', 'Cornsilk', 'Daisy', 'Dark Heather',
  'Forest Green', 'Graphite Heather', 'Gravel', 'Heliconia', 'Ice Grey',
  'Irish Green', 'Jade Dome', 'Kiwi', 'Light Blue', 'Light Pink',
  'Maroon', 'Midnight', 'Military Green', 'Natural', 'Navy',
  'Old Gold', 'Orange', 'Paragon', 'Purple', 'Red', 'Royal',
  'Russet', 'Sand', 'Sapphire', 'Sport Grey', 'Sunset', 'Tropical Blue',
  'Turf Green', 'Tweed',
]

/**
 * Get the catalog color list for a given product.
 * Tries to detect the brand/style from the SKU or title.
 * Falls back to a merged list of all catalogs.
 */
export function getCatalogColors(sku: string, title: string): string[] {
  const skuUpper = sku.toUpperCase()
  const titleLower = title.toLowerCase()

  // Comfort Colors detection
  if (
    skuUpper.startsWith('CC') ||
    skuUpper.includes('-CC') ||
    titleLower.includes('comfort colors') ||
    titleLower.includes('comfort colour')
  ) {
    return COMFORT_COLORS_1717
  }

  // Bella Canvas detection
  if (
    skuUpper.startsWith('BC') ||
    skuUpper.includes('-BC') ||
    titleLower.includes('bella canvas') ||
    titleLower.includes('bella+canvas')
  ) {
    return BELLA_CANVAS_3001
  }

  // Gildan detection
  if (
    skuUpper.startsWith('GL') ||
    skuUpper.startsWith('GD') ||
    skuUpper.includes('64000') ||
    titleLower.includes('gildan')
  ) {
    return GILDAN_64000
  }

  // Fallback: merge all catalogs (deduplicated)
  const all = new Set([
    ...COMFORT_COLORS_1717,
    ...BELLA_CANVAS_3001,
    ...GILDAN_64000,
  ])
  return Array.from(all)
}
