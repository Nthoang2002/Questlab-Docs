const fs = require('fs');
const path = require('path');

const root = __dirname;
const out = path.join(root, 'html');
const ignored = new Set(['html', 'node_modules', '.git']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    if (!/\.(md|d2)$/i.test(entry.name)) return [];
    return [absolute];
  });
}

function titleFor(relative, content) {
  if (relative.endsWith('.md')) {
    const heading = content.match(/^#\s+(.+)$/m);
    if (heading) return heading[1].replace(/[`*_]/g, '').trim();
  }
  return path.basename(relative, path.extname(relative))
    .replace(/^\d+-/, '')
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const docs = walk(root)
  .map((absolute) => {
    const relative = path.relative(root, absolute).replace(/\\/g, '/');
    const content = fs.readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '');
    return {
      path: relative,
      type: path.extname(relative).slice(1).toLowerCase(),
      group: relative.includes('/') ? relative.split('/')[0] : 'Bắt đầu',
      title: titleFor(relative, content),
      content,
    };
  })
  .sort((a, b) => {
    if (a.path === 'README.md') return -1;
    if (b.path === 'README.md') return 1;
    return a.path.localeCompare(b.path, 'vi');
  });

const data = JSON.stringify(docs).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
const template = fs.readFileSync(path.join(root, 'site-template.html'), 'utf8');
const html = template.replace('/*__DOCS_DATA__*/[]', data);

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html, 'utf8');
console.log(`Built ${docs.length} documents -> ${path.join(out, 'index.html')}`);
