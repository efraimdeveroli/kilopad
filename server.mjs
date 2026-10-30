// KiloPad early-access server (formerly YOLOPAD). Zero npm dependencies (Node >= 22.5).
// Env: PORT, DATA_DIR (sqlite location, mount a volume here), RPC_URL (use a paid RPC),
//      PINATA_JWT (metadata/image pinning), MOCK=1 (no external calls, for local testing)
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { checkFeesLockedToTreasury } from './verify.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dir, 'public');
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dir, 'data');
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PINATA_JWT = process.env.PINATA_JWT || '';
const MOCK = process.env.MOCK === '1';
const THRESHOLD_USD = 50;
const TREASURY = (process.env.TREASURY_ADDRESS || '').trim();
const FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';

fs.mkdirSync(DATA_DIR, { recursive: true });
const IMG_DIR = path.join(DATA_DIR, 'img');
fs.mkdirSync(IMG_DIR, { recursive: true });
const IMG_RE = /^\/img\/[a-f0-9]{40}\.(png|jpeg|gif|webp)$/;
// DB filename kept from YOLOPAD so the existing database keeps working.
const db = new DatabaseSync(path.join(DATA_DIR, 'yolopad.db'));
db.exec(`create table if not exists coins(
  mint text primary key, creator text not null, vault text, name text not null, symbol text not null,
  uri text, image text, market text not null, side text not null, tier integer not null,
  signature text not null, created_at integer not null)`);

const MARKETS = ['SOL', 'BTC', 'ETH'];
const SIDES = ['long', 'short'];
const TIERS = [2, 10, 100];
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const B58_OK_TREASURY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const treasuryOk = B58_OK_TREASURY.test(TREASURY);
const B58SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

// ---------- helpers ----------
const UPLOADS_PER_IP_HOUR = Number(process.env.UPLOADS_PER_IP_HOUR || 5);
const UPLOADS_PER_DAY = Number(process.env.UPLOADS_PER_DAY || 300);
let dayCount = { day: '', n: 0 };
function dailyCapHit() {
  const d = new Date().toISOString().slice(0, 10);
  if (dayCount.day !== d) dayCount = { day: d, n: 0 };
  return ++dayCount.n > UPLOADS_PER_DAY;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 3_600_000)) hits.delete(k); }, 600_000).unref();
const hits = new Map();
function limited(ip, key, max, windowMs) {
  const k = key + ip, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(k, arr);
  return arr.length > max;
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readJson(req, limit = 2_000_000) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('too_large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
async function rpc(method, params) {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc_error');
  return j.result;
}

// ---------- prices (cached) ----------
let priceCache = { at: 0, v: null };
async function prices() {
  if (MOCK) return { SOL: 104.42, BTC: 81556, ETH: 2422.5 };
  if (priceCache.v && Date.now() - priceCache.at < 60_000) return priceCache.v;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,bitcoin,ethereum&vs_currencies=usd', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const v = { SOL: j.solana.usd, BTC: j.bitcoin.usd, ETH: j.ethereum.usd };
    priceCache = { at: Date.now(), v }; return v;
  } catch { return priceCache.v; } // may be null, UI handles it
}

// ---------- creator fee balance (cached per vault) ----------
const feeCache = new Map();
async function vaultSol(vault) {
  if (!vault) return null;
  if (MOCK) return Number('0.' + (parseInt(vault.slice(0, 4), 36) % 90 + 5)) / 4;
  const c = feeCache.get(vault);
  if (c && Date.now() - c.at < 30_000) return c.v;
  try {
    const r = await rpc('getBalance', [vault, { commitment: 'confirmed' }]);
    // The vault is a program-owned account, so subtract rent-exempt minimum for a 0-data account.
    const v = Math.max(0, (r.value - 890880) / 1e9);
    feeCache.set(vault, { at: Date.now(), v }); return v;
  } catch { return c ? c.v : null; }
}

// ---------- API ----------
async function coinsApi() {
  const rows = db.prepare('select * from coins order by created_at desc limit 60').all();
  const px = await prices();
  const out = [];
  for (const r of rows) {
    const sol = await vaultSol(r.vault);
    const usd = sol != null && px && px.SOL ? sol * px.SOL : null;
    out.push({ mint: r.mint, creator: r.creator, name: r.name, symbol: r.symbol, image: r.image,
      market: r.market, side: r.side, tier: r.tier, createdAt: r.created_at,
      feeSol: sol, feeUsd: usd, ready: usd != null && usd >= THRESHOLD_USD });
  }
  return { thresholdUsd: THRESHOLD_USD, prices: px, coins: out };
}

async function upload(body) {
  if (!treasuryOk) throw new Error('Launching is paused.');
  const { name, symbol, description, image } = body;
  const m = /^data:(image\/(png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image || '');
  if (!m) throw new Error('Image must be a PNG, JPG, GIF or WEBP.');
  const bytes = Buffer.from(m[3], 'base64');
  if (bytes.length > 1_000_000) throw new Error('Image must be under 1 MB.');
  const hash = crypto.createHash('sha1').update(bytes).digest('hex');
  const local = '/img/' + hash + '.' + m[2];
  fs.writeFileSync(path.join(IMG_DIR, hash + '.' + m[2]), bytes);
  if (MOCK) return { uri: 'https://example.invalid/meta.json', image: local };
  if (!PINATA_JWT) throw new Error('Server is missing PINATA_JWT.');
  const auth = { Authorization: 'Bearer ' + PINATA_JWT };
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: m[1] }), 'coin.' + m[2]);
  const r1 = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: auth, body: fd });
  const j1 = await r1.json(); if (!j1.IpfsHash) throw new Error('Image upload failed.');
  const imgUrl = 'https://ipfs.io/ipfs/' + j1.IpfsHash;
  const meta = { name, symbol, description: description || '', image: imgUrl, showName: true, createdOn: 'https://pump.fun' };
  const r2 = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', { method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ pinataContent: meta }) });
  const j2 = await r2.json(); if (!j2.IpfsHash) throw new Error('Metadata upload failed.');
  return { uri: 'https://ipfs.io/ipfs/' + j2.IpfsHash, image: local };
}

async function buyTx(body) {
  const { publicKey, mint, amountSol } = body;
  if (!B58.test(publicKey || '') || !B58.test(mint || '')) throw new Error('Bad key.');
  const amt = Number(amountSol);
  if (!(amt > 0 && amt <= 5)) throw new Error('Buy must be above 0 and at most 5 SOL.');
  if (!db.prepare('select 1 from coins where mint = ?').get(mint)) throw new Error('Unknown coin.');
  if (MOCK) return Buffer.from('mock-transaction').toString('base64');
  const r = await fetch('https://pumpportal.fun/api/trade-local', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey, action: 'buy', mint, denominatedInSol: 'true', amount: amt, slippage: 10, priorityFee: 0.0005, pool: 'pump' }),
    signal: AbortSignal.timeout(20000) });
  if (r.status !== 200) throw new Error('pump.fun refused the buy request (' + r.status + ').');
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

async function confirmLaunch(body) {
  const { mint, creator, vault, sharingConfig, signature, name, symbol, uri, image, market, side, tier } = body;
  if (!treasuryOk) throw new Error('Launching is paused.');
  if (!B58.test(sharingConfig || '')) throw new Error('Missing fee-sharing config.');
  if (!B58.test(mint || '') || !B58.test(creator || '') || !B58SIG.test(signature || '')) throw new Error('Bad input.');
  if (vault && !B58.test(vault)) throw new Error('Bad vault.');
  if (!MARKETS.includes(market) || !SIDES.includes(side) || !TIERS.includes(Number(tier))) throw new Error('Bad settings.');
  if (!name || name.length > 32 || !symbol || symbol.length > 10) throw new Error('Bad name or ticker.');
  if (!MOCK) {
    let why = 'unchecked';
    for (let i = 0; i < 4 && why; i++) {
      if (i) await new Promise(r => setTimeout(r, 1500));
      const info = await rpc('getAccountInfo', [sharingConfig, { encoding: 'base64', commitment: 'confirmed' }]);
      why = checkFeesLockedToTreasury(info && info.value, mint, TREASURY, FEES_PROGRAM);
    }
    if (why) throw new Error(why + " This coin can't be listed because its fees aren't locked to the treasury.");
  }
  if (!MOCK) {
    const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    if (!tx || tx.meta?.err) throw new Error('That transaction did not succeed.');
    const keys = tx.transaction.message.accountKeys;
    const has = (k, signer) => keys.some(a => a.pubkey === k && (!signer || a.signer));
    if (!has(mint, true) || !has(creator, true)) throw new Error('Transaction does not match this launch.');
  }
  db.prepare(`insert or ignore into coins(mint,creator,vault,name,symbol,uri,image,market,side,tier,signature,created_at)
    values(?,?,?,?,?,?,?,?,?,?,?,?)`).run(mint, creator, vault || null, name, symbol.toUpperCase(), uri || null,
    image && IMG_RE.test(image) ? image : null, market, side, Number(tier), signature, Date.now());
  return { ok: true };
}

const RPC_ALLOW = new Set(['sendTransaction', 'getSignatureStatuses', 'getLatestBlockhash', 'getBalance', 'getBlockHeight']);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',').pop().trim();
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && url.pathname === '/api/coins') return send(res, 200, await coinsApi());
      if (req.method === 'GET' && url.pathname === '/api/vault') {
        const row = db.prepare('select vault, creator from coins where mint = ?').get(url.searchParams.get('mint') || '');
        if (!row) return send(res, 404, { error: 'unknown mint' });
        if (MOCK) return send(res, 200, { vault: row.vault, creator: row.creator, mock: true });
        const info = await rpc('getAccountInfo', [row.vault, { encoding: 'base64', commitment: 'confirmed' }]);
        const v = info && info.value;
        return send(res, 200, { vault: row.vault, creator: row.creator, exists: !!v,
          lamports: v ? v.lamports : 0, owner: v ? v.owner : null, dataBytes: v ? Buffer.from(v.data[0], 'base64').length : 0 });
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { treasury: treasuryOk ? TREASURY : null });
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { ok: true, mock: MOCK, pinata: !!PINATA_JWT, treasury: treasuryOk });
      if (req.method !== 'POST') return send(res, 405, { error: 'method' });
      if (limited(ip, 'p', 60, 60_000)) return send(res, 429, { error: 'Slow down.' });
      if (url.pathname === '/api/upload') {
        if (limited(ip, 'u', UPLOADS_PER_IP_HOUR, 3_600_000)) return send(res, 429, { error: 'Too many launches from your connection. Try again in an hour.' });
        if (dailyCapHit()) return send(res, 429, { error: 'Launch limit reached for today. Try again tomorrow.' });
      }
      if (url.pathname === '/api/launch/buy' && limited(ip, 't', 10, 3_600_000)) return send(res, 429, { error: 'Too many launch attempts. Try again in an hour.' });
      const body = await readJson(req, 3_000_000);
      if (url.pathname === '/api/upload') return send(res, 200, await upload(body));
      if (url.pathname === '/api/launch/buy') return send(res, 200, { tx: await buyTx(body) });
      if (url.pathname === '/api/launch/confirm') return send(res, 200, await confirmLaunch(body));
      if (url.pathname === '/api/rpc') {
        if (!RPC_ALLOW.has(body.method)) return send(res, 400, { error: 'method not allowed' });
        if (MOCK) return send(res, 200, { jsonrpc: '2.0', id: body.id, result: mockRpc(body) });
        const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params: body.params }) });
        return send(res, r.status, await r.text());
      }
      return send(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && IMG_RE.test(url.pathname)) {
      const f = path.join(IMG_DIR, path.basename(url.pathname));
      if (!fs.existsSync(f)) return send(res, 404, 'not found', 'text/plain');
      const ext = path.extname(f).slice(1);
      res.writeHead(200, { 'content-type': 'image/' + ext, 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end(fs.readFileSync(f));
    }
    // static
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const f = path.normalize(path.join(PUB, p));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    send(res, 200, fs.readFileSync(f), types[path.extname(f)] || 'application/octet-stream');
  } catch (e) {
    send(res, 400, { error: String(e.message || e) });
  }
});
function mockRpc(b) {
  if (b.method === 'sendTransaction') return '5'.repeat(88);
  if (b.method === 'getLatestBlockhash') return { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 } };
  if (b.method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'confirmed', err: null }] };
  return null;
}
server.listen(PORT, () => console.log(`kilopad on :${PORT}${MOCK ? ' (MOCK)' : ''}`));
