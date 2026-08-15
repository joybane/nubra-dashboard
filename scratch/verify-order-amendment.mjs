// End-to-end smoke of the paper routes touched by the amendment work.
// Run against a server started with PAPER_DB_PATH pointing at a COPY of paper.db.
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3099';

let failures = 0;

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, json };
}

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${actual}, want ${expected})`);
}

// ── validation, live ─────────────────────────────────────────────────────────
check('modify with empty patch', (await call('POST', '/paper/orders/modify/1', {})).status, 400);
check(
  'modify with zero qty',
  (await call('POST', '/paper/orders/modify/1', { order_qty: 0 })).status,
  400,
);
check(
  'modify with negative price',
  (await call('POST', '/paper/orders/modify/1', { order_price: -1 })).status,
  400,
);
check(
  'modify a non-numeric id',
  (await call('POST', '/paper/orders/modify/abc', { order_qty: 1 })).status,
  400,
);
check(
  'modify an order that does not exist',
  (await call('POST', '/paper/orders/modify/99999999', { order_price: 100 })).status,
  404,
);
check('empty basket body', (await call('POST', '/paper/baskets', {})).status, 400);
check(
  'basket with no legs',
  (await call('POST', '/paper/baskets', { name: 'a', symbol: 'NIFTY', expiry: '20260827' })).status,
  400,
);
check('snapshots list while authenticated', (await call('GET', '/paper/strategy/snapshots')).status, 200);
check('baskets list still parses', (await call('GET', '/paper/baskets')).status, 200);

// ── a real amendment, end to end ─────────────────────────────────────────────
// A ref_id the simulator has never seen has no cached tick, so the order rests OPEN.
const REF = 987654321;
const placed = await call('POST', '/paper/orders', {
  nubraName: 'SMOKE_TEST_CE',
  liveRefId: REF,
  display_name: 'SMOKE TEST CE',
  order_type: 'ORDER_TYPE_REGULAR',
  order_side: 'ORDER_SIDE_BUY',
  order_qty: 65,
  order_price: 100_00,
  order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
  validity_type: 'DAY',
});
check('place a resting limit', placed.status, 200);
const id = placed.json?.order_id;
console.log(`      order_id=${id}`);

const amended = await call('POST', `/paper/orders/modify/${id}`, {
  order_price: 123_45,
  order_qty: 130,
});
check('amend it', amended.status, 200);
check('response carries the order', amended.json?.order?.order_id, id);
check('new price applied', amended.json?.order?.order_price, 123_45);
check('new qty applied', amended.json?.order?.order_qty, 130);
check('still open', amended.json?.order?.order_status, 'ORDER_STATUS_OPEN');
check('fill block untouched', amended.json?.order?.filled_qty, 0);

// Read it back off the API to be sure it is not just the echoed object.
const live = await call('GET', '/paper/orders?live=1');
const found = (live.json || []).find((o) => o.order_id === id);
check('re-read price', found?.order_price, 123_45);
check('re-read qty', found?.order_qty, 130);

const cancelled = await call('DELETE', `/paper/orders/${id}`);
check('cancel the smoke order', cancelled.status, 200);
check(
  'cannot amend a cancelled order',
  (await call('POST', `/paper/orders/modify/${id}`, { order_price: 200_00 })).status,
  404,
);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
// Set the code rather than calling process.exit(): forcing exit while undici still holds
// keep-alive sockets trips a libuv assertion on Windows and makes a clean run look like a crash.
process.exitCode = failures === 0 ? 0 : 1;
