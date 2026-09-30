import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { chunk } from "./geckoterminal.js";

const CHAIN = "solana";
export const REGISTRY_WORKER_NAME = "registry_seed";
const PAGE_SIZE = 1000;
// keeps the `address=in.(...)` query string well under url length limits.
const EXISTS_CHUNK_SIZE = 100;

interface RegistryMint {
  address: string;
  underlyingSymbol: string | null;
}

async function selectRegistryMints(errors: string[]): Promise<RegistryMint[] | null> {
  const mints: RegistryMint[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("rwa_issuers")
      .select("mint_address, underlying_symbol")
      .eq("chain", CHAIN)
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      errors.push(`query rwa_issuers: ${error.message}`);
      return null;
    }
    const page = data ?? [];
    mints.push(
      ...page.map((row) => ({
        address: row.mint_address as string,
        underlyingSymbol: (row.underlying_symbol as string | null) ?? null,
      })),
    );
    if (page.length < PAGE_SIZE) break;
  }
  return mints;
}

async function selectExistingTokenAddresses(
  addresses: string[],
  errors: string[],
): Promise<Set<string> | null> {
  const existing = new Set<string>();
  for (const batch of chunk(addresses, EXISTS_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("tokens")
      .select("address")
      .eq("chain", CHAIN)
      .in("address", batch);

    if (error) {
      errors.push(`query tokens: ${error.message}`);
      return null;
    }
    for (const row of data ?? []) existing.add(row.address as string);
  }
  return existing;
}

export interface RegistrySeedOptions {
  dryRun?: boolean;
}

/**
 * Ensures every solana mint in rwa_issuers has a tokens row, so registry
 * assets get priced even when they never show up in pool discovery. Inserts
 * chain + address, symbol (from the registry's underlying_symbol) and
 * discovery_source='registry', and never touches existing rows (on conflict
 * do nothing) -- name/decimals are left null for other sources to fill.
 *
 * Returns the registry mints that are guaranteed to exist in tokens, or []
 * if the seed failed: token_metrics has an fk to tokens, so handing jupiter
 * an address with no tokens row would fail its whole insert.
 *
 * With dryRun, reads the registry and checks tokens as normal but writes
 * nothing (no upsert, no worker_status) -- it only logs the counts, and
 * returns just the mints that already exist in tokens.
 */
export async function runRegistrySeed({ dryRun = false }: RegistrySeedOptions = {}): Promise<string[]> {
  const errors: string[] = [];

  const registry = await selectRegistryMints(errors);
  const mints = registry?.map((m) => m.address) ?? null;
  const existing = mints && mints.length > 0
    ? await selectExistingTokenAddresses(mints, errors)
    : new Set<string>();

  if (mints && existing) {
    const missing = mints.filter((address) => !existing.has(address));
    console.log(
      `registry${dryRun ? " (dry run)" : ""}: ${mints.length} registry mints read, ` +
        `${existing.size} already in tokens, ` +
        `${missing.length} ${dryRun ? "would be" : "to be"} inserted`,
    );
  }

  if (dryRun) {
    if (errors.length > 0) {
      console.error(`registry dry run completed with ${errors.length} error(s):`, errors);
    }
    return mints && existing ? mints.filter((address) => existing.has(address)) : [];
  }

  let seeded: string[] = [];

  if (registry && mints && mints.length > 0) {
    const rows = registry.map((m) => ({
      chain: CHAIN,
      address: m.address,
      symbol: m.underlyingSymbol,
      discovery_source: "registry",
    }));
    // .select() returns only the rows actually inserted -- with
    // ignoreDuplicates, conflicting rows are skipped and not returned.
    const { data, error } = await supabase
      .from("tokens")
      .upsert(rows, { onConflict: "chain,address", ignoreDuplicates: true })
      .select("address");
    if (error) {
      errors.push(`seed tokens from rwa_issuers: ${error.message}`);
    } else {
      seeded = mints;
      console.log(`registry: inserted ${data?.length ?? 0} new tokens rows`);
    }
  }

  console.log(`registry: ensured ${seeded.length} registry mints in tokens`);
  await writeWorkerStatus(REGISTRY_WORKER_NAME, errors);

  if (errors.length > 0) {
    console.error(`registry seed completed with ${errors.length} error(s):`, errors);
  }

  return seeded;
}
