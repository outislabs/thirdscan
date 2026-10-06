import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { supabase } from "./supabase.js";

// re-verifies rwa_issuers against the migrations that wrote it. nothing at
// runtime writes this table (registry.ts only reads it), so the migrations
// are the complete expected state: any missing, extra or changed row means
// someone wrote to it outside the repo. run with `npm run verify-registry`;
// exits 1 on any difference.
//
// every migration that writes rwa_issuers is found automatically and must
// be one of the two shapes below; anything else fails the run rather than
// silently comparing against a stale expectation:
//   insert into rwa_issuers (cols) values (...), ... on conflict (...) do nothing;
//   update rwa_issuers as ri set col = v.col, ... from (values ...) as v(cols)
//     where ri.chain = '<chain>' and ri.mint_address = v.mint_address;
//
// compares against every local migration, so run it with the repo in sync
// with the remote (supabase migration list): an unpushed seed reads as
// missing rows.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
const PAGE_SIZE = 1000;
const MAX_LISTED = 50;
// numeric columns, read as text: postgrest returns numeric as a json
// number, which rounds anything past ~16 significant digits (e.g. the
// 18-decimal current_multiplier). a new numeric column missing from this
// list shows up as spurious diffs, never as silently skipped ones.
const NUMERIC_COLUMNS = ["current_multiplier"];
// set by the database, not by the migrations; reported, not compared.
const DB_SET_COLUMNS = new Set(["id", "added_at"]);

/** a sql numeric literal or ::numeric cast, kept exact as a string. */
class Num {
  readonly value: string;
  constructor(raw: string) {
    let s = raw.trim().replace(/^\+/, "");
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    this.value = s === "-0" ? "0" : s;
  }
}

type Value = null | boolean | string | Num | unknown;
type Row = Record<string, Value>;

const rowKey = (chain: unknown, mint: unknown) => `${String(chain)}|${String(mint)}`;

/** parses `(...), (...), ...` value tuples starting at `pos`. */
function parseTuples(sql: string, pos: number): { tuples: Value[][]; end: number } {
  let i = pos;
  const skipSpace = () => {
    while (/\s/.test(sql[i])) i++;
  };
  const tuples: Value[][] = [];
  for (;;) {
    skipSpace();
    if (sql[i] === ",") {
      i++;
      skipSpace();
    }
    if (sql[i] !== "(") break;
    i++;
    const tuple: Value[] = [];
    for (;;) {
      skipSpace();
      let value: Value;
      if (sql[i] === "'") {
        let text = "";
        let j = i + 1;
        for (;;) {
          if (j >= sql.length) throw new Error("unterminated string literal");
          if (sql[j] === "'" && sql[j + 1] === "'") {
            text += "'";
            j += 2;
          } else if (sql[j] === "'") break;
          else text += sql[j++];
        }
        i = j + 1;
        value = text;
        if (sql.startsWith("::jsonb", i)) {
          value = JSON.parse(text);
          i += "::jsonb".length;
        } else if (sql.startsWith("::numeric", i)) {
          value = new Num(text);
          i += "::numeric".length;
        } else if (sql.startsWith("::", i)) {
          throw new Error(`unsupported cast ${sql.slice(i, i + 20)}`);
        }
      } else {
        const m = /^(null|true|false|[+-]?\d+(?:\.\d+)?)\b/i.exec(sql.slice(i, i + 64));
        if (!m) throw new Error(`unsupported value near: ${sql.slice(i, i + 40)}`);
        const token = m[1].toLowerCase();
        value = token === "null" ? null : token === "true" ? true : token === "false" ? false : new Num(token);
        i += m[1].length;
      }
      tuple.push(value);
      skipSpace();
      if (sql[i] === ",") {
        i++;
        continue;
      }
      if (sql[i] === ")") {
        i++;
        break;
      }
      throw new Error(`unexpected ${JSON.stringify(sql.slice(i, i + 30))} in values list`);
    }
    tuples.push(tuple);
  }
  return { tuples, end: i };
}

const splitColumns = (list: string) => list.split(",").map((c) => c.trim());

/** applies one migration's rwa_issuers writes to `expected`, in file order. */
function applyMigration(file: string, sql: string, expected: Map<string, Row>): string[] {
  const applied: string[] = [];
  const writeRe = /\b(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:public\.)?rwa_issuers\b/gi;
  for (let m: RegExpExecArray | null; (m = writeRe.exec(sql)); ) {
    const verb = m[1].toLowerCase().split(/\s+/)[0];
    const rest = sql.slice(m.index);

    if (verb === "insert") {
      const head = /^insert\s+into\s+(?:public\.)?rwa_issuers\s*\(([^)]*)\)\s*values\b/i.exec(rest);
      if (!head) throw new Error(`${file}: insert into rwa_issuers without a column list + values`);
      const columns = splitColumns(head[1]);
      const { tuples, end } = parseTuples(sql, m.index + head[0].length);
      if (!/^\s*on\s+conflict\s*\([^)]*\)\s*do\s+nothing\s*;/i.test(sql.slice(end))) {
        throw new Error(`${file}: only 'on conflict (...) do nothing' inserts are supported`);
      }
      let inserted = 0;
      for (const tuple of tuples) {
        if (tuple.length !== columns.length) throw new Error(`${file}: tuple width != column count`);
        const row = Object.fromEntries(columns.map((c, k) => [c, tuple[k]]));
        const key = rowKey(row.chain, row.mint_address);
        if (expected.has(key)) continue; // on conflict do nothing
        expected.set(key, row);
        inserted++;
      }
      applied.push(`${file}: insert, ${inserted} of ${tuples.length} rows new`);
      writeRe.lastIndex = end;
      continue;
    }

    if (verb === "update") {
      const head = /^update\s+(?:public\.)?rwa_issuers\s+as\s+ri\s+set\s+([\s\S]*?)\s+from\s*\(\s*values\b/i.exec(rest);
      if (!head) throw new Error(`${file}: update rwa_issuers not in the 'set ... from (values ...) as v(...)' shape`);
      const assignments = head[1].split(",").map((a) => {
        const am = /^\s*(\w+)\s*=\s*v\.(\w+)\s*$/.exec(a);
        if (!am) throw new Error(`${file}: unsupported set clause '${a.trim()}'`);
        return [am[1], am[2]] as const;
      });
      const { tuples, end } = parseTuples(sql, m.index + head[0].length);
      const tail = /^\s*\)\s*as\s+v\s*\(([^)]*)\)\s*where\s+ri\.chain\s*=\s*'([^']+)'\s+and\s+ri\.mint_address\s*=\s*v\.mint_address\s*;/i.exec(
        sql.slice(end),
      );
      if (!tail) throw new Error(`${file}: update rwa_issuers with an unsupported alias or where clause`);
      const columns = splitColumns(tail[1]);
      let matched = 0;
      for (const tuple of tuples) {
        const v = Object.fromEntries(columns.map((c, k) => [c, tuple[k]]));
        const row = expected.get(rowKey(tail[2], v.mint_address));
        if (!row) continue; // the update's join matches nothing
        for (const [target, source] of assignments) row[target] = v[source];
        matched++;
      }
      applied.push(`${file}: update, ${matched} of ${tuples.length} rows matched`);
      writeRe.lastIndex = end + tail[0].length;
      continue;
    }

    throw new Error(`${file}: '${m[0]}' isn't supported; teach verifyRegistry.ts how to apply it`);
  }
  return applied;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function sameValue(expectedValue: Value, liveValue: unknown): boolean {
  if (expectedValue instanceof Num) {
    return liveValue !== null && liveValue !== undefined && new Num(String(liveValue)).value === expectedValue.value;
  }
  return deepEqual(expectedValue ?? null, liveValue ?? null);
}

function show(value: unknown): string {
  const text = value instanceof Num ? value.value : JSON.stringify(value ?? null);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

async function fetchLive(): Promise<Row[]> {
  const casts = NUMERIC_COLUMNS.map((c) => `${c}_text:${c}::text`).join(", ");
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("rwa_issuers")
      .select(`*, ${casts}`)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`query rwa_issuers: ${error.message}`);
    // the select string is built at runtime, so supabase-js can't type it.
    const page = (data ?? []) as unknown as Row[];
    for (const row of page) {
      for (const c of NUMERIC_COLUMNS) {
        row[c] = row[`${c}_text`];
        delete row[`${c}_text`];
      }
      rows.push(row);
    }
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function main(): Promise<void> {
  const expected = new Map<string, Row>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    for (const line of applyMigration(file, readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8"), expected)) {
      console.log(`  ${line}`);
    }
  }

  const live = await fetchLive();
  const liveByKey = new Map(live.map((r) => [rowKey(r.chain, r.mint_address), r]));
  const columns = Object.keys(live[0] ?? {}).filter((c) => !DB_SET_COLUMNS.has(c));
  console.log(`expected ${expected.size} rows from migrations; live ${live.length} rows`);
  console.log(`columns compared: ${columns.join(", ")}`);

  const missing = [...expected.keys()].filter((k) => !liveByKey.has(k));
  const extra = live.filter((r) => !expected.has(rowKey(r.chain, r.mint_address)));
  const changed: string[] = [];
  for (const [key, row] of expected) {
    const liveRow = liveByKey.get(key);
    if (!liveRow) continue;
    for (const c of columns) {
      if (!sameValue(row[c] ?? null, liveRow[c])) {
        changed.push(`${key} ${c}: expected ${show(row[c])}, live ${show(liveRow[c])}`);
      }
    }
  }

  const list = (title: string, items: string[]) => {
    console.log(`\n${title}: ${items.length}`);
    for (const item of items.slice(0, MAX_LISTED)) console.log(`  ${item}`);
    if (items.length > MAX_LISTED) console.log(`  ... and ${items.length - MAX_LISTED} more`);
  };
  list("missing rows", missing);
  list(
    "extra rows",
    extra.map((r) => `${rowKey(r.chain, r.mint_address)} id=${r.id} added_at=${r.added_at} issuer=${show(r.issuer_name)}`),
  );
  list("changed fields", changed);

  // context for spotting deletes and re-inserts: a re-inserted row gets a
  // new id and a fresh added_at even when its values match.
  const ids = live.map((r) => Number(r.id)).sort((a, b) => a - b);
  const gaps = ids.slice(1).flatMap((id, k) => (id !== ids[k] + 1 ? [`${ids[k]}->${id}`] : []));
  const byDay = new Map<string, number>();
  for (const r of live) {
    const day = String(r.added_at).slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  console.log(`\nid range ${ids[0]}-${ids[ids.length - 1]}, gaps: ${gaps.join(", ") || "none"}`);
  console.log(`added_at by day: ${[...byDay].sort().map(([d, n]) => `${d}=${n}`).join(", ")}`);

  const clean = missing.length === 0 && extra.length === 0 && changed.length === 0;
  console.log(clean ? "\nrwa_issuers matches its migrations." : "\nrwa_issuers DIFFERS from its migrations.");
  process.exitCode = clean ? 0 : 1;
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 2;
});
