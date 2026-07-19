async function test() {
  const res = await fetch('http://localhost:3000/api/optionchain/NIFTY?exchange=NSE&expiry=20260728');
  console.log('Status:', res.status);
  const data = await res.json();
  const ce = data.chain?.ce || data.ce || [];
  console.log('CE count:', ce.length);
  const strike24350 = ce.find(c => Number(c.sp) === 24350 || Number(c.sp) === 2435000);
  console.log('Strike 24350 details:', strike24350);
}

test().catch(console.error);
