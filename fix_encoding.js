const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

const replacements = [
  [/â€"/g, '\u2014'],   // em dash
  [/â€"/g, '\u2013'],   // en dash
  [/â€™/g, '\u2019'],   // right single quote
  [/â€˜/g, '\u2018'],   // left single quote
  [/â€œ/g, '\u201C'],   // left double quote
  [/â€\x9D/g, '\u201D'],// right double quote
  [/â€¢/g, '\u2022'],   // bullet
  [/Â·/g, '\u00B7'],    // middle dot
  [/â€¦/g, '\u2026'],   // ellipsis
  [/Ã—/g, '\u00D7'],    // multiplication
  [/â†'/g, '\u2192'],   // right arrow
  [/â†"/g, '\u2193'],   // down arrow
  [/Â½/g, '\u00BD'],    // half
  [/Â /g, ''],          // non-breaking space artifact
  [/Ã\u0097/g, '\u00D7'], // alt multiplication
  // Mojibake emoji (UTF-8 as latin1) — just remove
  [/ðŸ"Š/g, ''],
  [/ðŸ§¹/g, ''],
  [/âŒ/g, ''],
  [/âœ…/g, ''],
  [/ðŸ"ˆ/g, ''],
  [/ðŸ'¡/g, ''],
  [/ðŸ"¥/g, ''],
  [/ðŸ"/g, ''],
  // Common remaining patterns
  [/Ã¢â‚¬â€œ/g, '\u2014'],
  [/Ã¢â‚¬â„¢/g, '\u2019'],
  [/Ã¢â‚¬Â¢/g, '\u2022'],
  [/Ã¢â‚¬Â¦/g, '\u2026'],
  [/Â\xA0/g, ' '],
];

for (const [pat, rep] of replacements) {
  html = html.replace(pat, rep);
}

// Also clean up any remaining Â followed by nothing useful
html = html.replace(/Â(?=[^A-Za-z])/g, '');

fs.writeFileSync('index.html', html, 'utf8');

// Count remaining suspicious patterns
const remaining = (html.match(/[Ã¢Â][€â‚¬]/g) || []).length;
console.log('Remaining suspicious patterns:', remaining);
console.log('Done. File size:', fs.statSync('index.html').size);
