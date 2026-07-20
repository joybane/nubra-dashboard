const http = require('http');

const payload = JSON.stringify({
  exchange: 'NSE',
  multiplier: 1,
  orders: [
    {
      ref_id: 12345,
      order_qty: 65,
      strike: 24150,
      option_type: 'CE',
      ltp: 89.75,
      lot_size: 65,
      expiry: '2026-07-21',
      symbol: 'NIFTY',
      order_side: 'ORDER_SIDE_SELL',
      order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY'
    },
    {
      ref_id: 12346,
      order_qty: 65,
      strike: 24150,
      option_type: 'PE',
      ltp: 91.90,
      lot_size: 65,
      expiry: '2026-07-21',
      symbol: 'NIFTY',
      order_side: 'ORDER_SIDE_SELL',
      order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY'
    }
  ]
});

const req = http.request('http://localhost:3000/paper/margin/basket', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('Status Code:', res.statusCode);
    console.log('Response JSON:', body);
  });
});

req.on('error', (err) => console.error('Error:', err.message));
req.write(payload);
req.end();
