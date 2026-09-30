import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { chunk } from "./geckoterminal.js";
import { CHAIN, normalizeAddress } from "./chain.js";

export const REGISTRY_WORKER_NAME = "registry_seed";
const PAGE_SIZE = 1000;
// keeps the `address=in.(...)` query string well under url length limits.
const EXISTS_CHUNK_SIZE = 100;

interface RegistryMint {
  address: string;
  underlyingSymbol: string | null;
  // coalesce(logo_url, raw_payload->>'logo'): robinhood rows carry the
  // logo in its own logo_url column; xstocks rows only have it in
  // raw_payload.
  logo: string | null;
}

async function selectRegistryMints(errors: string[]): Promise<RegistryMint[] | null> {
  const mints: RegistryMint[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("rwa_issuers")
      .select("mint_address, underlying_symbol, logo_url, payload_logo:raw_payload->>logo")
      .eq("chain", CHAIN)
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      errors.push(`query rwa_issuers: ${error.message}`);
      return null;
    }
    const page = data ?? [];
    mints.push(
      ...page.map((row) => ({
        address: normalizeAddress(row.mint_address as string),
        underlyingSymbol: (row.underlying_symbol as string | null) ?? null,
        logo: (row.logo_url as string | null) || (row.payload_logo as string | null) || null,
      })),
    );
    if (page.length < PAGE_SIZE) break;
  }
  return mints;
}

/** address -> current image_url, for the given addresses that exist in tokens. */
async function selectExistingTokens(
  addresses: string[],
  errors: string[],
): Promise<Map<string, string | null> | null> {
  const existing = new Map<string, string | null>();
  for (const batch of chunk(addresses, EXISTS_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("tokens")
      .select("address, image_url")
      .eq("chain", CHAIN)
      .in("address", batch);

    if (error) {
      errors.push(`query tokens: ${error.message}`);
      return null;
    }
    for (const row of data ?? []) {
      existing.set(row.address as string, (row.image_url as string | null) ?? null);
    }
  }
  return existing;
}

export interface RegistrySeedOptions {
  dryRun?: boolean;
}

/**
 * Ensures every CHAIN mint in rwa_issuers has a tokens row, so registry
 * assets get priced even when they never show up in pool discovery. Inserts
 * chain + address, symbol (from the registry's underlying_symbol) and
 * discovery_source='registry', and never touches existing rows (on conflict
 * do nothing) -- name/decimals are left null for other sources to fill.
 *
 * Returns the registry mints that are guaranteed to exist in tokens, or []
 * if the seed failed: token_metrics has an fk to tokens, so any caller that
 * prices these must only use addresses with a tokens row.
 *
 * Also sets image_url from the registry logo: on insert for new rows, and
 * for existing rows whose image_url is null or differs (the registry is
 * authoritative for its own mints). a missing logo never nulls out an
 * existing image_url.
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
    ? await selectExistingTokens(mints, errors)
    : new Map<string, string | null>();

  // existing rows whose image_url should change to the registry logo.
  const logoUpdates = (registry ?? []).filter(
    (m) => m.logo !== null && existing !== null && existing.has(m.address) && existing.get(m.address) !== m.logo,
  );

  if (mints && existing) {
    const missing = mints.filter((address) => !existing.has(address));
    console.log(
      `registry${dryRun ? " (dry run)" : ""}: ${mints.length} registry mints read, ` +
        `${existing.size} already in tokens, ` +
        `${missing.length} ${dryRun ? "would be" : "to be"} inserted, ` +
        `${logoUpdates.length} existing image_url(s) ${dryRun ? "would be" : "to be"} set from registry logo`,
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
      image_url: m.logo,
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

  if (logoUpdates.length > 0) {
    // rows already exist (they came from the existence check), so this
    // upsert only ever takes the update path, and only image_url changes.
    const rows = logoUpdates.map((m) => ({ chain: CHAIN, address: m.address, image_url: m.logo }));
    const { error } = await supabase
      .from("tokens")
      .upsert(rows, { onConflict: "chain,address", ignoreDuplicates: false });
    if (error) {
      errors.push(`set image_url from registry logo: ${error.message}`);
    } else {
      console.log(`registry: set image_url on ${rows.length} existing tokens rows`);
    }
  }

  console.log(`registry: ensured ${seeded.length} registry mints in tokens`);
  await writeWorkerStatus(REGISTRY_WORKER_NAME, errors);

  if (errors.length > 0) {
    console.error(`registry seed completed with ${errors.length} error(s):`, errors);
  }

  return seeded;
}
