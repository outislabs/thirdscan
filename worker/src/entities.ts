import { supabase } from "./supabase.js";
import { writeWorkerStatus } from "./workerStatus.js";
import { CHAIN } from "./chain.js";

export const ENTITY_LABELS_WORKER_NAME = "entity_labels";
const PAGE_SIZE = 1000;
const LOOKUP_CHUNK = 100;

export type EntityType = "deployer" | "team" | "cex" | "lp_pool" | "bridge" | "burn" | "smart_money";

export interface EntityLabelRow {
  address: string; // lowercased
  label: string;
  type: EntityType;
  tokenAddress: string | null; // null = global
  source: string;
}

function key(address: string, type: string, tokenAddress: string | null): string {
  return `${address}|${type}|${tokenAddress ?? ""}`;
}

/**
 * Inserts labels that don't exist yet and leaves existing ones alone (so a
 * hand-set label is never overwritten by a heuristic one). entity_labels is
 * unique on an expression index, which postgrest's on_conflict can't target,
 * so this checks first. returns how many were inserted.
 */
export async function insertLabelsIfMissing(rows: EntityLabelRow[], errors: string[]): Promise<number> {
  if (rows.length === 0) return 0;
  const existing = new Set<string>();
  const addresses = [...new Set(rows.map((r) => r.address))];
  for (let i = 0; i < addresses.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from("entity_labels")
      .select("address, type, token_address")
      .eq("chain", CHAIN)
      .in("address", addresses.slice(i, i + LOOKUP_CHUNK));
    if (error) {
      errors.push(`check entity_labels: ${error.message}`);
      return 0;
    }
    for (const r of data ?? []) {
      existing.add(key(r.address as string, r.type as string, (r.token_address as string | null) ?? null));
    }
  }

  const seen = new Set<string>();
  const fresh = rows.filter((r) => {
    const k = key(r.address, r.type, r.tokenAddress);
    if (existing.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (fresh.length === 0) return 0;

  const { error } = await supabase.from("entity_labels").insert(
    fresh.map((r) => ({
      chain: CHAIN,
      address: r.address,
      label: r.label,
      type: r.type,
      token_address: r.tokenAddress,
      source: r.source,
    })),
  );
  if (error) {
    errors.push(`insert entity_labels: ${error.message}`);
    return 0;
  }
  return fresh.length;
}

// blockscout names verified contracts, so a holder that is a contract named
// like a dex or a bridge is labeled as such. a heuristic: it only ever adds
// labels and never overwrites one.
const BRIDGE_PATTERN = /bridge|gateway|portal/i;
const POOL_PATTERN = /pool|pair|uniswap|ramses|camelot|sushi|pancake|liquidity|router|\bdex\b|\bswap/i;

export function classifyContractName(name: string): EntityType | null {
  if (BRIDGE_PATTERN.test(name)) return "bridge";
  if (POOL_PATTERN.test(name)) return "lp_pool";
  return null;
}

/**
 * Labels top-holder contracts as lp_pool / bridge from their blockscout
 * name. db-only (no blockscout calls): holders.ts already stores
 * is_contract and the name.
 */
export async function runEntityLabelCycle(): Promise<void> {
  const errors: string[] = [];
  const found = new Map<string, EntityLabelRow>();

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("token_holders")
      .select("holder_address, label")
      .eq("chain", CHAIN)
      .eq("is_contract", true)
      .not("label", "is", null)
      .not("holder_address", "is", null)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      errors.push(`query contract holders: ${error.message}`);
      break;
    }
    const page = data ?? [];
    for (const row of page) {
      const address = (row.holder_address as string).toLowerCase();
      const label = row.label as string;
      const type = classifyContractName(label);
      if (type) found.set(key(address, type, null), { address, label, type, tokenAddress: null, source: "blockscout_name" });
    }
    if (page.length < PAGE_SIZE) break;
  }

  const inserted = await insertLabelsIfMissing([...found.values()], errors);
  console.log(`entity labels: ${found.size} labeled contract holders, ${inserted} new label(s)`);
  await writeWorkerStatus(ENTITY_LABELS_WORKER_NAME, errors);
  if (errors.length > 0) console.error(`entity label cycle completed with ${errors.length} error(s):`, errors);
}
