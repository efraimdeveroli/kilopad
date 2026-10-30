import { b58decode, b58encode, decodeSharingConfig, checkFeesLockedToTreasury } from './verify.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
assert.deepEqual([...b58decode('11111111111111111111111111111111')], new Array(32).fill(0));
for (let i = 0; i < 200; i++) { const b = crypto.randomBytes(32); if (i % 7 === 0) b[0] = 0; assert.deepEqual([...b58decode(b58encode(b))], [...b]); }
const mint = crypto.randomBytes(32), treasury = crypto.randomBytes(32), other = crypto.randomBytes(32);
function acct({ revoked = true, holders = [[treasury, 10000]], m = mint, owner = 'FEES' } = {}) {
  const parts = [Buffer.alloc(8), Buffer.from([254, 2, 0]), m, crypto.randomBytes(32), Buffer.from([revoked ? 1 : 0])];
  const len = Buffer.alloc(4); len.writeUInt32LE(holders.length); parts.push(len);
  for (const [a, bps] of holders) { const x = Buffer.alloc(2); x.writeUInt16LE(bps); parts.push(a, x); }
  return { owner, data: [Buffer.concat(parts).toString('base64'), 'base64'] };
}
const M = b58encode(mint), T = b58encode(treasury);
assert.equal(checkFeesLockedToTreasury(acct(), M, T, 'FEES'), null);
assert.match(checkFeesLockedToTreasury(acct({ revoked: false }), M, T, 'FEES'), /not locked/);
assert.match(checkFeesLockedToTreasury(acct({ holders: [[other, 10000]] }), M, T, 'FEES'), /treasury/);
assert.match(checkFeesLockedToTreasury(acct({ holders: [[treasury, 9000], [other, 1000]] }), M, T, 'FEES'), /treasury/);
assert.match(checkFeesLockedToTreasury(acct({ m: crypto.randomBytes(32) }), M, T, 'FEES'), /different coin/);
assert.match(checkFeesLockedToTreasury(acct({ owner: 'X' }), M, T, 'FEES'), /owner/);
assert.match(checkFeesLockedToTreasury(null, M, T, 'FEES'), /No fee-sharing/);
assert.match(checkFeesLockedToTreasury({ owner: 'FEES', data: ['AAAA', 'base64'] }, M, T, 'FEES'), /Could not read/);
console.log('all verify tests passed');
