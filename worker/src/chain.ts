// the single chain this worker runs against. robinhood chain (evm, chainId
// 4663) -- 'robinhood' is both the geckoterminal network id and the
// dexscreener chainId, and the chain value used in tokens / rwa_issuers.
// the solana-only job (jupiter) keeps its own 'solana' constant and is
// paused in index.ts; solana rows already in the
// database are left as they are.
export const CHAIN = "robinhood";
export const GECKOTERMINAL_NETWORK = "robinhood";
// evm chain id, used by blockscout's pro api (robinhood chain's explorer).
export const EVM_CHAIN_ID = 4663;

// the native-asset placeholder geckoterminal reports as a pool's base token
// (e.g. eth-quoted pools). it isn't a token contract, so discovery skips it.
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * evm addresses are case-insensitive (mixed case is only an eip-55
 * checksum), so every address is stored and compared lowercased. pool ids
 * that are 32-byte uniswap v4 hashes are hex too, so the same applies.
 */
export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}
