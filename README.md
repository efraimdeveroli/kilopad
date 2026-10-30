# KiloPad (early access, formerly YOLOPAD)

Launch coins on pump.fun and list them in Explore with creator-fee progress toward $50. No YOLO positions yet.
Zero npm dependencies. Needs Node >= 22.5.

## Run
    PINATA_JWT=... RPC_URL=https://your-paid-rpc node --no-warnings server.mjs
Local UI test with no external calls: `MOCK=1 node --no-warnings server.mjs`

## Env
- PINATA_JWT  (required) free Pinata account JWT, used to pin the coin image and metadata
- RPC_URL     (strongly advised) a paid Solana RPC; the public one rate-limits
- DATA_DIR    where yolopad.db (SQLite) lives; mount a persistent volume here on Railway
- TREASURY_ADDRESS  (required) public address that receives every coin's creator fees. Launching is paused until it is set
- PORT

## Not verified (the build sandbox could not reach Solana, pump.fun or npm)
- the PumpPortal trade-local create call, and the units of the dev buy amount
- the creator-vault PDA seed ("creator-vault") and that the vault holds plain SOL; the fee numbers in Explore depend on it
- fee numbers are per creator wallet (pump.fun pools a creator's fees across all their coins), so a creator with several coins sees the same number on each
- the web3.js import loads from esm.sh in the visitor's browser

## Fee redirect (Option C)
Each launch is ONE transaction: pump.fun create_v2 + create_fee_sharing_config + update_fee_shares_v2 (100% to TREASURY_ADDRESS, admin revoked). If the transaction would be too large, the page falls back to two sequential transactions.
The server reads the coin's sharing_config account on-chain and only lists the coin if it pays 100% to the treasury and is locked (see verify.mjs, test with `node test-verify.mjs`).
Not verified against mainnet: the SDK calls (@pump-fun/pump-sdk 4.1.0 via esm.sh), the one-transaction size, the optional initial buy via PumpPortal.
