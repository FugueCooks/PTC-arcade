import assert from 'node:assert/strict';
import test from 'node:test';
import { TokenService } from '../server/src/token/token-service.js';

const MINT = 'FakeM1ntAddre55111111111111111111111111111';
const WALLET = 'Wa11etAddre55111111111111111111111111111';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

void test('an unconfigured token stands down instead of failing', async () => {
  const service = new TokenService({ fetchImpl: () => { throw new Error('must not be called'); } });
  assert.equal(service.configured, false);
  assert.equal(service.buyUrl, null);
  assert.equal(await service.market(), null);
  assert.equal(await service.holding(WALLET), null);
});

void test('the buy link is the pump.fun coin page', () => {
  const service = new TokenService({ mint: MINT });
  assert.equal(service.buyUrl, `https://pump.fun/coin/${MINT}`);
});

void test('price comes from Jupiter first, and is cached', async () => {
  const calls: string[] = [];
  let clock = 0;
  const service = new TokenService({
    mint: MINT,
    now: () => clock,
    fetchImpl: (async (url: string) => {
      calls.push(String(url));
      return jsonResponse({ [MINT]: { usdPrice: 0.0042, priceChange24h: 12.5 } });
    }) as typeof fetch
  });
  const market = await service.market();
  assert.equal(market?.price, 0.0042);
  assert.equal(market?.change24h, 12.5);
  assert.equal(market?.source, 'jupiter');
  clock = 30_000;
  await service.market();
  assert.equal(calls.length, 1, 'a thirty-second-old price is not refetched');
  clock = 61_000;
  await service.market();
  assert.equal(calls.length, 2, 'a stale price is');
});

void test('DexScreener answers when Jupiter cannot, with market cap', async () => {
  const service = new TokenService({
    mint: MINT,
    fetchImpl: (async (url: string) => {
      if (String(url).includes('jup.ag')) return jsonResponse({}, false);
      return jsonResponse({
        pairs: [
          { priceUsd: '0.001', fdv: 90_000, priceChange: { h24: -3 }, liquidity: { usd: 5_000 } },
          { priceUsd: '0.002', fdv: 95_000, priceChange: { h24: -2 }, liquidity: { usd: 50_000 } }
        ]
      });
    }) as typeof fetch
  });
  const market = await service.market();
  assert.equal(market?.source, 'dexscreener');
  assert.equal(market?.price, 0.002, 'the deepest pool is the one quoted');
  assert.equal(market?.marketCap, 95_000);
});

void test('a failed refresh keeps the stale price rather than blanking it', async () => {
  let healthy = true;
  let clock = 0;
  const service = new TokenService({
    mint: MINT,
    now: () => clock,
    fetchImpl: (async () => {
      if (!healthy) return jsonResponse({}, false);
      return jsonResponse({ [MINT]: { usdPrice: 1 } });
    }) as typeof fetch
  });
  assert.equal((await service.market())?.price, 1);
  healthy = false;
  clock = 120_000;
  assert.equal((await service.market())?.price, 1, 'the aggregator hiccup does not blank the panel');
});

void test('a holding sums token accounts and lands in the dollar tier', async () => {
  const service = new TokenService({
    mint: MINT,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (String(url).includes('jup.ag')) return jsonResponse({ [MINT]: { usdPrice: 0.01 } });
      assert.match(String(init?.body), /getTokenAccountsByOwner/);
      return jsonResponse({
        result: { value: [
          { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 2_000 } } } } } },
          { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 1_500 } } } } } }
        ] }
      });
    }) as typeof fetch
  });
  const holding = await service.holding(WALLET);
  // 3,500 tokens at a cent is $35: past the $3 and $30 tiers, short of $150.
  assert.equal(holding?.amount, 3_500);
  assert.equal(holding?.usd, 35);
  assert.equal(holding?.tier, 2);
});

void test('a wallet that is not an address is refused before RPC', async () => {
  const service = new TokenService({ mint: MINT, fetchImpl: () => { throw new Error('must not reach RPC'); } });
  assert.equal(await service.holding('DROP TABLE wallets'), null);
  assert.equal(await service.holding(''), null);
  assert.equal(TokenService.isWalletAddress(WALLET), true);
});

void test('tier thresholds are dollars, so tier 0 is simply holding little', async () => {
  const service = new TokenService({
    mint: MINT,
    fetchImpl: (async (url: string) => {
      if (String(url).includes('jup.ag')) return jsonResponse({ [MINT]: { usdPrice: 0.01 } });
      return jsonResponse({ result: { value: [
        { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 100 } } } } } }
      ] } });
    }) as typeof fetch
  });
  const holding = await service.holding(WALLET);
  assert.equal(holding?.usd, 1);
  assert.equal(holding?.tier, 0);
});
