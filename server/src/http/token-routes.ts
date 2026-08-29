import type { Express, Request, Response } from 'express';
import { TokenService } from '../token/token-service.js';

/**
 * The token, readable by anyone.
 *
 * Balances are public on-chain, so the holding endpoint takes an address
 * rather than demanding a session: showing a player their own tier and
 * letting anyone check the treasury are the same read. Nothing here writes,
 * signs, or moves anything — entitlements that ACT on a tier resolve the
 * address server-side from the authenticated wallet identity, not from this.
 */
export function installTokenRoutes(app: Express, tokens: TokenService): void {
  app.get('/api/token', async (_request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!tokens.configured) {
      response.json({ ok: true, configured: false, symbol: tokens.symbol });
      return;
    }
    const [market, treasury] = await Promise.all([tokens.market(), tokens.treasury()]);
    response.json({
      ok: true,
      configured: true,
      symbol: tokens.symbol,
      mint: tokens.mint,
      buyUrl: tokens.buyUrl,
      tiersUsd: tokens.tierUsd,
      market,
      // The prize pool is the dev wallet: creator fees accumulate there and
      // nothing is bought back. The wallet is the ledger.
      treasury
    });
  });

  app.get('/api/token/holding', async (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!tokens.configured) {
      response.json({ ok: true, configured: false });
      return;
    }
    const address = String(request.query.address ?? '');
    if (!TokenService.isWalletAddress(address)) {
      response.status(400).json({ ok: false, message: 'A Solana wallet address is required.' });
      return;
    }
    const holding = await tokens.holding(address);
    if (!holding) {
      response.status(503).json({ ok: false, message: 'The balance could not be read right now.' });
      return;
    }
    response.json({ ok: true, configured: true, address, ...holding });
  });
}
