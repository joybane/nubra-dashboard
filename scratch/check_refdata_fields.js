import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const session = JSON.parse(fs.readFileSync('session.json', 'utf8'));
const mpin = process.env.MPIN;
const baseUrl = process.env.NUBRA_BASE_URL || 'https://api2.nubra.io';

async function test() {
  const loginRes = await fetch(`${baseUrl}/verifypin`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.authToken}`
    },
    body: JSON.stringify({ pin: mpin })
  });
  
  const loginData = await loginRes.json();
  const sessionToken = loginData.session_token || loginData.data?.token;
  
  const today = new Date().toISOString().slice(0, 10);
  const refRes = await fetch(`${baseUrl}/refdata/refdata/${today}?exchange=NSE`, {
    headers: { Authorization: `Bearer ${sessionToken}` }
  });
  const raw = await refRes.json();
  console.log('Keys of raw:', Object.keys(raw));
  if (raw.refdata) {
    console.log('raw.refdata type:', typeof raw.refdata, Array.isArray(raw.refdata) ? 'array' : 'not array');
    if (Array.isArray(raw.refdata)) {
      console.log('Sample refdata items:', raw.refdata.slice(0, 3));
    }
  } else {
    console.log('raw snippet:', JSON.stringify(raw).slice(0, 500));
  }
}

test().catch(console.error);
