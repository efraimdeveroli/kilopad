// Decodes a pump.fun Pump Fees `SharingConfig` account and checks it pays 100% to one address, locked.
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = ALPH.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.push(Number(n & 0xffn)); n >>= 8n; }
  bytes.reverse();
  let zeros = 0; for (const c of s) { if (c === '1') zeros++; else break; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}
export function b58encode(u8) {
  let n = 0n; for (const b of u8) n = n * 256n + BigInt(b);
  let out = ''; while (n > 0n) { out = ALPH[Number(n % 58n)] + out; n /= 58n; }
  let zeros = 0; for (const b of u8) { if (b === 0) zeros++; else break; }
  return '1'.repeat(zeros) + out;
}
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Layout (Anchor/Borsh): 8 disc | bump u8 | version u8 | status u8 | mint 32 | admin 32 | admin_revoked u8 | vec<{address 32, share_bps u16 LE}> (u32 LE len)
export function decodeSharingConfig(buf) {
  if (buf.length < 8 + 3 + 64 + 1 + 4) throw new Error('account too small');
  let o = 8;
  const bump = buf[o++], version = buf[o++], status = buf[o++];
  const mint = buf.subarray(o, o + 32); o += 32;
  const admin = buf.subarray(o, o + 32); o += 32;
  const adminRevoked = buf[o++] === 1;
  const len = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24); o += 4;
  if (len < 0 || len > 10 || buf.length < o + len * 34) throw new Error('bad shareholder list');
  const shareholders = [];
  for (let i = 0; i < len; i++) {
    shareholders.push({ address: buf.subarray(o, o + 32), bps: buf[o + 32] | (buf[o + 33] << 8) });
    o += 34;
  }
  return { bump, version, status, mint, admin, adminRevoked, shareholders };
}
// returns null if OK, else a human-readable reason
export function checkFeesLockedToTreasury(account, mintB58, treasuryB58, feesProgram) {
  if (!account) return 'No fee-sharing config found for this coin.';
  if (account.owner !== feesProgram) return 'Fee-sharing account has the wrong owner.';
  let c; try { c = decodeSharingConfig(Buffer.from(account.data[0], 'base64')); } catch { return 'Could not read the fee-sharing config.'; }
  if (!eq(c.mint, b58decode(mintB58))) return 'Fee-sharing config belongs to a different coin.';
  if (!c.adminRevoked) return 'Fee settings are not locked yet.';
  if (c.shareholders.length !== 1 || c.shareholders[0].bps !== 10000 || !eq(c.shareholders[0].address, b58decode(treasuryB58)))
    return 'Fees do not go 100% to the treasury.';
  return null;
}
