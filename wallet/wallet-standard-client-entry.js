import { getWallets } from '@wallet-standard/app';
import { createSignInMessage } from '@solana/wallet-standard-util';
import {
  registerMwa, createDefaultAuthorizationCache, createDefaultChainSelector, createDefaultWalletNotFoundHandler
} from '@solana-mobile/wallet-standard-mobile';

const bytesToBase64 = (bytes) => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
};

const serializeOutput = (account, output) => ({
  account: { address: account.address, publicKey: bytesToBase64(account.publicKey) },
  signedMessage: bytesToBase64(output.signedMessage),
  signature: bytesToBase64(output.signature),
  ...(output.signatureType ? { signatureType: output.signatureType } : {})
});

export class PtcWalletClient {
  constructor({ appName = 'PTC Arcade', appUri = location.origin, network = 'mainnet-beta' } = {}) {
    this.walletsApi = getWallets();
    this.wallet = undefined;
    this.account = undefined;
    this.unsubscribe = undefined;
    this.accountChangeListener = undefined;
    this.network = network;
    if (/Android/i.test(navigator.userAgent)) {
      try {
        registerMwa({
          appIdentity: { name: appName, uri: appUri, icon: '/favicon.ico' },
          authorizationCache: createDefaultAuthorizationCache(),
          chains: [`solana:${network === 'mainnet-beta' ? 'mainnet' : network}`],
          chainSelector: createDefaultChainSelector(),
          onWalletNotFound: createDefaultWalletNotFoundHandler()
        });
      } catch { /* Extension and injected wallets remain available. */ }
    }
  }

  wallets() {
    return this.walletsApi.get().filter((wallet) => wallet.features['standard:connect']
      && (wallet.features['solana:signIn'] || wallet.features['solana:signMessage']));
  }

  async connect(walletName) {
    const wallet = this.wallets().find((candidate) => candidate.name === walletName);
    if (!wallet) throw new Error('That wallet is no longer available.');
    const result = await wallet.features['standard:connect'].connect();
    const account = result.accounts?.[0] ?? wallet.accounts?.[0];
    if (!account) throw new Error('The wallet did not provide an account.');
    this.wallet = wallet; this.account = account;
    this.unsubscribe?.();
    const events = wallet.features['standard:events'];
    this.unsubscribe = events?.on('change', ({ accounts }) => {
      const next = accounts?.[0] ?? wallet.accounts?.[0];
      const previousAddress = this.account?.address;
      this.account = next;
      if (next?.address !== previousAddress) this.accountChangeListener?.(next?.address);
    });
    return { walletName: wallet.name, address: account.address };
  }

  onAccountChange(listener) { this.accountChangeListener = listener; }
  currentAddress() { return this.account?.address; }

  async signIn(input) {
    if (!this.wallet || !this.account) throw new Error('Connect a wallet first.');
    if (input.address !== this.account.address) throw new Error('The connected wallet changed. Request a new sign-in.');
    const signIn = this.wallet.features['solana:signIn'];
    if (signIn) {
      const outputs = await signIn.signIn(input);
      const output = outputs?.[0];
      if (!output) throw new Error('The wallet did not return a signature.');
      return serializeOutput(output.account, output);
    }
    const signMessage = this.wallet.features['solana:signMessage'];
    if (!signMessage) throw new Error('This wallet cannot sign login messages.');
    const message = createSignInMessage(input);
    const outputs = await signMessage.signMessage({ account: this.account, message });
    const output = outputs?.[0];
    if (!output) throw new Error('The wallet did not return a signature.');
    return serializeOutput(this.account, output);
  }

  async disconnect() {
    try { await this.wallet?.features['standard:disconnect']?.disconnect(); } finally {
      this.unsubscribe?.(); this.unsubscribe = undefined;
      this.wallet = undefined; this.account = undefined;
    }
  }
}

window.PtcWalletClient = PtcWalletClient;
