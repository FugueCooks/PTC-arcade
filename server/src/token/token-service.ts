/**
 * The arcade's token, read rather than trusted.
 *
 * Everything here is public on-chain or public market data: the token's price
 * from an aggregator, and any wallet's balance from RPC. Nothing signs,
 * nothing transfers, and the service works unconfigured — until a mint is set
 * the endpoints say so instead of failing, so the site does not depend on the
 * token existing to boot.
 *
 * Price comes from Jupiter first and DexScreener second. Jupiter quotes
 * anything with a route, which covers a pump.fun token from its first trade;
 * DexScreener adds market cap and the 24h move once a pool exists. Both are
 * cached, because a lobby full of players does not need to ask twice a second
 * what one number is.
 */

const MARKET_CACHE_MS = 60_000;
const HOLDING_CACHE_MS = 300_000;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface TokenMarket {
  price: number | null;
  marketCap: number | null;
  change24h: number | null;
  source: 'jupiter' | 'dexscreener' | null;
  fetchedAt: number;
}

export interface TokenHolding {
  amount: number;
  usd: number | null;
  tier: number;
}

export interface TokenServiceOptions {
  mint?: string;
  symbol?: string;
  rpcUrl?: string;
  tierUsd?: number[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class TokenService {
  readonly mint: string | null;
  readonly symbol: string;
  readonly tierUsd: number[];
  readonly #rpcUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #market: TokenMarket | null = null;
  #holdings = new Map<string, { holding: TokenHolding; fetchedAt: number }>();

  constructor(options: TokenServiceOptions = {}) {
    this.mint = options.mint?.trim() || null;
    this.symbol = options.symbol?.trim() || 'PTC';
    this.tierUsd = options.tierUsd ?? [3, 30, 150];
    this.#rpcUrl = options.rpcUrl?.trim() || 'https://api.mainnet-beta.solana.com';
    this.#fetch = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.#now = options.now ?? (() => Date.now());
  }

  get configured(): boolean {
    return this.mint !== null;
  }

  /** The pump.fun page for the token, where buying actually happens. */
  get buyUrl(): string | null {
    return this.mint ? `https://pump.fun/coin/${this.mint}` : null;
  }

  static isWalletAddress(value: string): boolean {
    return BASE58_ADDRESS.test(value);
  }

  async market(): Promise<TokenMarket | null> {
    if (!this.mint) return null;
    const now = this.#now();
    if (this.#market && now - this.#market.fetchedAt < MARKET_CACHE_MS) return this.#market;
    const fresh = (await this.#fromJupiter()) ?? (await this.#fromDexScreener());
    // A failed refresh keeps the stale answer rather than blanking the panel:
    // a minute-old price beats no price during an aggregator hiccup.
    if (fresh) this.#market = { ...fresh, fetchedAt: now };
    else this.#market ??= { price: null, marketCap: null, change24h: null, source: null, fetchedAt: now };
    return this.#market;
  }

  /**
   * What a wallet holds, priced, and which holder tier that lands in. Tier 0
   * is everyone; each threshold met is one tier up. The thresholds are in
   * dollars so they do not get harder to reach when the token does well.
   */
  async holding(address: string): Promise<TokenHolding | null> {
    if (!this.mint || !TokenService.isWalletAddress(address)) return null;
    const now = this.#now();
    const cached = this.#holdings.get(address);
    if (cached && now - cached.fetchedAt < HOLDING_CACHE_MS) return cached.holding;
    const amount = await this.#balance(address);
    if (amount === null) return cached?.holding ?? null;
    const price = (await this.market())?.price ?? null;
    const usd = price === null ? null : amount * price;
    const tier = usd === null ? 0 : this.tierUsd.filter((threshold) => usd >= threshold).length;
    const holding = { amount, usd, tier };
    this.#holdings.set(address, { holding, fetchedAt: now });
    if (this.#holdings.size > 5000) {
      const oldest = this.#holdings.keys().next().value;
      if (oldest !== undefined) this.#holdings.delete(oldest);
    }
    return holding;
  }

  async #fromJupiter(): Promise<Omit<TokenMarket, 'fetchedAt'> | null> {
    try {
      const response = await this.#fetch(`https://lite-api.jup.ag/price/v3?ids=${this.mint}`);
      if (!response.ok) return null;
      const body = (await response.json()) as Record<string, { usdPrice?: number; priceChange24h?: number } | undefined>;
      const entry = body?.[this.mint as string];
      if (!entry || typeof entry.usdPrice !== 'number') return null;
      return {
        price: entry.usdPrice,
        marketCap: null,
        change24h: typeof entry.priceChange24h === 'number' ? entry.priceChange24h : null,
        source: 'jupiter'
      };
    } catch {
      return null;
    }
  }

  async #fromDexScreener(): Promise<Omit<TokenMarket, 'fetchedAt'> | null> {
    try {
      const response = await this.#fetch(`https://api.dexscreener.com/latest/dex/tokens/${this.mint}`);
      if (!response.ok) return null;
      const body = (await response.json()) as { pairs?: Array<{ priceUsd?: string; fdv?: number; priceChange?: { h24?: number }; liquidity?: { usd?: number } }> };
      const pair = (body.pairs ?? []).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const price = pair?.priceUsd === undefined ? null : Number(pair.priceUsd);
      if (price === null || !Number.isFinite(price)) return null;
      return {
        price,
        marketCap: typeof pair?.fdv === 'number' ? pair.fdv : null,
        change24h: typeof pair?.priceChange?.h24 === 'number' ? pair.priceChange.h24 : null,
        source: 'dexscreener'
      };
    } catch {
      return null;
    }
  }

  /** The wallet's balance of the mint, summed across its token accounts. */
  async #balance(address: string): Promise<number | null> {
    try {
      const response = await this.#fetch(this.#rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [address, { mint: this.mint }, { encoding: 'jsonParsed' }]
        })
      });
      if (!response.ok) return null;
      const body = (await response.json()) as {
        result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } } } }> };
        error?: unknown;
      };
      if (body.error || !body.result?.value) return null;
      return body.result.value.reduce((total, entry) => total + (entry.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
    } catch {
      return null;
    }
  }
}
