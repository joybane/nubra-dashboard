const http = require('http');
const body = JSON.stringify({
  query: [{
    exchange: 'NSE', type: 'INDEX', values: ['NIFTY'], fields: ['open', 'high', 'low', 'close'],
    startDate: new Date(Date.now() - 86400000).toISOString(),
    endDate: new Date().toISOString(),
    interval: '1m', intraDay: false, realTime: false
  }]
});
const req = http.request({
  hostname: 'localhost', port: 3000, path: '/api/historical', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
}, (res) => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const bars = parsed.result[0].values[0]['NIFTY'].open || [];
      console.log('Total bars:', bars.length);
      console.log('Last 3 bars:', bars.slice(-3));
    } catch(e) { console.error('Error parsing:', e.message, data.substring(0, 100)); }
  });
});
req.write(body);
req.end();
