// After the @fastify/static v8 → v10 major bump: does it still serve the SPA, still set the
// cache headers the old setHeaders callback set, and still refuse to walk out of dist/?
const BASE = process.argv[2] || 'http://127.0.0.1:3999';

async function probe(pathname, label) {
  const res = await fetch(`${BASE}${pathname}`, { redirect: 'manual' });
  const body = res.status === 200 ? await res.text() : '';
  return {
    label,
    path: pathname,
    status: res.status,
    type: res.headers.get('content-type')?.split(';')[0] ?? '(none)',
    cacheControl: res.headers.get('cache-control') ?? '(none)',
    bytes: body.length,
    looksLikeSpa: body.includes('<div id="root">'),
  };
}

console.log('--- SPA entry point ---');
console.log(JSON.stringify(await probe('/', 'index.html'), null, 0));
console.log(JSON.stringify(await probe('/index.html', 'index.html explicit'), null, 0));

console.log('\n--- a hashed asset (must be cacheable, not no-store) ---');
const index = await (await fetch(`${BASE}/`)).text();
const asset = index.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0];
console.log('discovered asset:', asset);
if (asset) console.log(JSON.stringify(await probe(asset, 'hashed js'), null, 0));

console.log('\n--- traversal attempts (all must fail) ---');
for (const p of [
  '/../.env',
  '/..%2f.env',
  '/..%252f.env',
  '/%2e%2e/%2e%2e/.env',
  '/../session.json',
  '/../paper.db',
]) {
  const r = await probe(p, 'traversal');
  console.log(`${p.padEnd(26)} -> ${r.status} ${r.bytes} bytes`);
}
