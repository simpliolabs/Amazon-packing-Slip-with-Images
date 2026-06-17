const fix = (text, brand) => {
  if (!text || !/^the\s/i.test(brand)) return text
  const esc = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`\\b(?:the|a|an)\\s+(?=${esc}\\b)`, 'gi'), '')
}
console.log('1.', fix('Step into effortless style with the THE CEO Darlin T-Shirt, a standout', 'THE CEO'))
console.log('2. no false hit:', fix('the theme of the CEO suite is the central thing', 'THE CEO'))
console.log('3. non-THE brand untouched:', fix('with the Acme Shirt', 'Acme'))
