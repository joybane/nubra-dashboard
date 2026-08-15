// Probes the CORS + WebSocket origin policy against a real running server.
// Point it at a throwaway instance (see the runner command) — never the live one.
import { WebSocket } from 'ws';

const BASE = process.argv[2] || 'http://127.0.0.1:3999';
const WSBASE = BASE.replace('http', 'ws');

async function corsProbe(origin) {
  const res = await fetch(`${BASE}/paper/auth/status`, { headers: origin ? { Origin: origin } : {} });
  return {
    origin: origin ?? '(none)',
    status: res.status,
    allowOrigin: res.headers.get('access-control-allow-origin') ?? '(absent)',
  };
}

async function preflightProbe(origin) {
  const res = await fetch(`${BASE}/paper/orders`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  return {
    origin,
    status: res.status,
    allowOrigin: res.headers.get('access-control-allow-origin') ?? '(absent)',
  };
}

function wsProbe(origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WSBASE}/ws`, { headers: { Origin: origin } });
    const done = (r) => {
      try {
        ws.close();
      } catch {}
      resolve({ origin, ...r });
    };
    ws.on('open', () => done({ result: 'CONNECTED' }));
    ws.on('unexpected-response', (_req, res) => done({ result: `REFUSED ${res.statusCode}` }));
    ws.on('error', (e) => done({ result: 'ERROR ' + e.message }));
    setTimeout(() => done({ result: 'TIMEOUT' }), 4000);
  });
}

console.log('--- CORS (simple request) ---');
for (const o of [undefined, 'http://localhost:8000', 'https://evil.example.com']) {
  console.log(JSON.stringify(await corsProbe(o)));
}

console.log('\n--- CORS preflight on POST /paper/orders ---');
for (const o of ['http://localhost:8000', 'https://evil.example.com']) {
  console.log(JSON.stringify(await preflightProbe(o)));
}

console.log('\n--- WebSocket upgrade ---');
for (const o of ['http://localhost:8000', 'https://evil.example.com']) {
  console.log(JSON.stringify(await wsProbe(o)));
}
