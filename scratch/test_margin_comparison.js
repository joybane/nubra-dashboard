async function fetchOptionChain(expiry) {
  const url = `http://localhost:3000/api/optionchain/NIFTY?exchange=NSE${expiry ? `&expiry=${expiry}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} calling optionchain`);
  const data = await res.json();
  return data.chain || data;
}

async function fetchMargin(orders) {
  const res = await fetch('http://localhost:3000/paper/margin/basket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exchange: 'NSE', multiplier: 1, orders })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} calling margin/basket`);
  return await res.json();
}

async function test() {
  console.log('Fetching NIFTY expiries and option chains...');
  const chain21 = await fetchOptionChain('20260721');
  const chain28 = await fetchOptionChain('20260728');
  
  const ce21 = chain21.ce || [];
  const pe21 = chain21.pe || [];
  const ce28 = chain28.ce || [];
  
  // Find specific contracts
  const getContract = (list, strike) => list.find(c => Number(c.sp) === strike || Number(c.sp) === strike * 100);

  const ce24300_21 = getContract(ce21, 24300);
  const ce24400_21 = getContract(ce21, 24400);
  
  const pe24200_21 = getContract(pe21, 24200);
  const pe24300_21 = getContract(pe21, 24300);
  const ce24500_21 = getContract(ce21, 24500);
  
  const ce24350_21 = getContract(ce21, 24350);
  const ce24350_28 = getContract(ce28, 24350);

  console.log('\n--- 1. Testing Strategy: Bull Call Spread ---');
  // Buy 24,300 CE, Sell 24,400 CE on 21 Jul 26
  if (ce24300_21 && ce24400_21) {
    const orders = [
      { ref_id: ce24300_21.ref_id, order_qty: 65, order_side: 'ORDER_SIDE_BUY', order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY', strike: 24300, option_type: 'CE', expiry: '20260721', symbol: 'NIFTY' },
      { ref_id: ce24400_21.ref_id, order_qty: 65, order_side: 'ORDER_SIDE_SELL', order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY', strike: 24400, option_type: 'CE', expiry: '20260721', symbol: 'NIFTY' }
    ];
    const margin = await fetchMargin(orders);
    const rawTotal = Math.round(margin.total_margin / 1.068);
    console.log(`Dashboard Total Margin (with 6.8% buffer): ₹${(margin.total_margin / 100).toLocaleString('en-IN')}`);
    console.log(`Nubra Raw Total Margin (without buffer): ₹${(rawTotal / 100).toLocaleString('en-IN')}`);
    console.log(`Span Margin: ₹${((margin.span || 0) / 106.8).toLocaleString('en-IN')}`);
    console.log(`Exposure Margin: ₹${((margin.exposure || 0) / 106.8).toLocaleString('en-IN')}`);
    console.log(`Premium Payable: ₹${((margin.opt_prem || 0) / 100).toLocaleString('en-IN')}`);
    console.log(`Margin Benefit: ₹${((margin.margin_benefit || 0) / 106.8).toLocaleString('en-IN')}`);
  } else {
    console.log('Missing contracts for Bull Call Spread');
  }

  console.log('\n--- 2. Testing Strategy: Iron Condor ---');
  // Buy 24,200 PE, Sell 24,300 PE, Sell 24,400 CE, Buy 24,500 CE on 21 Jul 26
  if (pe24200_21 && pe24300_21 && ce24400_21 && ce24500_21) {
    const orders = [
      { ref_id: pe24200_21.ref_id, order_qty: 65, order_side: 'ORDER_SIDE_BUY', order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY', strike: 24200, option_type: 'PE', expiry: '20260721', symbol: 'NIFTY' },
      { ref_id: pe24300_21.ref_id, order_qty: 65, order_side: 'ORDER_SIDE_SELL', order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY', strike: 24300, option_type: 'PE', expiry: '20260721', symbol: 'NIFTY' },
      { ref_id: ce24400_21.ref_id, order_qty: 65, order_side: 'ORDER_SIDE_SELL', order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY', strike: 24400, option_type: 'CE', expiry: '20260721', symbol: 'NIFTY' },
      { ref_id: ce24500_21.ref_id, order_qty: 65, order_side: 'ORDER_SIDE_BUY', order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY', strike: 24500, option_type: 'CE', expiry: '20260721', symbol: 'NIFTY' }
    ];
    const margin = await fetchMargin(orders);
    const rawTotal = Math.round(margin.total_margin / 1.068);
    console.log(`Dashboard Total Margin (with 6.8% buffer): ₹${(margin.total_margin / 100).toLocaleString('en-IN')}`);
    console.log(`Nubra Raw Total Margin (without buffer): ₹${(rawTotal / 100).toLocaleString('en-IN')}`);
    console.log(`Span Margin: ₹${((margin.span || 0) / 106.8).toLocaleString('en-IN')}`);
    console.log(`Exposure Margin: ₹${((margin.exposure || 0) / 106.8).toLocaleString('en-IN')}`);
    console.log(`Premium Payable: ₹${((margin.opt_prem || 0) / 100).toLocaleString('en-IN')}`);
    console.log(`Margin Benefit: ₹${((margin.margin_benefit || 0) / 106.8).toLocaleString('en-IN')}`);
  } else {
    console.log('Missing contracts for Iron Condor');
  }

  console.log('\n--- 3. Testing Strategy: Calendar Spread ---');
  // Sell 24,350 CE on 21 Jul 26, Buy 24,350 CE on 28 Jul 26
  if (ce24350_21 && ce24350_28) {
    const orders = [
      { ref_id: ce24350_21.ref_id, order_qty: 65, order_side: 'ORDER_SIDE_SELL', order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY', strike: 24350, option_type: 'CE', expiry: '20260721', symbol: 'NIFTY' },
      { ref_id: ce24350_28.ref_id, order_qty: 65, order_side: 'ORDER_SIDE_BUY', order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY', strike: 24350, option_type: 'CE', expiry: '20260728', symbol: 'NIFTY' }
    ];
    const margin = await fetchMargin(orders);
    const rawTotal = Math.round(margin.total_margin / 1.068);
    console.log(`Dashboard Total Margin (with 6.8% buffer): ₹${(margin.total_margin / 100).toLocaleString('en-IN')}`);
    console.log(`Nubra Raw Total Margin (without buffer): ₹${(rawTotal / 100).toLocaleString('en-IN')}`);
    console.log(`Span Margin: ₹${((margin.span || 0) / 106.8).toLocaleString('en-IN')}`);
    console.log(`Exposure Margin: ₹${((margin.exposure || 0) / 106.8).toLocaleString('en-IN')}`);
    console.log(`Premium Payable: ₹${((margin.opt_prem || 0) / 100).toLocaleString('en-IN')}`);
    console.log(`Margin Benefit: ₹${((margin.margin_benefit || 0) / 106.8).toLocaleString('en-IN')}`);
  } else {
    console.log('Missing contracts for Calendar Spread');
  }
}

test().catch(console.error);
