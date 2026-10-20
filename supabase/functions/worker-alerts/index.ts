// Checks worker_status and sends a telegram message when a worker goes stale
// (last_run_at older than 3x its interval) or its last_error changes.
// Invoked by pg_cron every 5 minutes; deploy with --no-verify-jwt, the
// x-cron-secret header is the auth.
//
// secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WORKER_ALERTS_CRON_SECRET.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the runtime.

import { createClient } from "npm:@supabase/supabase-js@2";

const STALE_FACTOR = 3;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function sendTelegram(text: string): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${Deno.env.get("TELEGRAM_BOT_TOKEN")}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Deno.env.get("TELEGRAM_CHAT_ID"), text }),
    },
  );
  if (!res.ok) {
    throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 120 ? `${min} min` : `${(min / 60).toFixed(1)} h`;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("WORKER_ALERTS_CRON_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }

  const [config, status, state] = await Promise.all([
    supabase.from("worker_alert_config").select("worker_name, interval_seconds"),
    supabase.from("worker_status").select("worker_name, last_run_at, last_error"),
    supabase.from("worker_alert_state").select("worker_name, is_stale, last_error_seen"),
  ]);
  for (const r of [config, status, state]) {
    if (r.error) return new Response(r.error.message, { status: 500 });
  }

  const statusByName = new Map(status.data!.map((s) => [s.worker_name, s]));
  const stateByName = new Map(state.data!.map((s) => [s.worker_name, s]));
  const now = Date.now();
  const messages: string[] = [];
  const updates: { worker_name: string; is_stale: boolean; last_error_seen: string | null; updated_at: string }[] = [];

  for (const { worker_name, interval_seconds } of config.data!) {
    const s = statusByName.get(worker_name);
    const prev = stateByName.get(worker_name);
    const lastRun = s?.last_run_at ? new Date(s.last_run_at).getTime() : null;
    const age = lastRun === null ? Infinity : now - lastRun;
    const isStale = age > STALE_FACTOR * interval_seconds * 1000;
    const lastError = s?.last_error ?? null;

    if (isStale && !prev?.is_stale) {
      messages.push(
        `STALE ${worker_name}: last run ${lastRun === null ? "never" : ago(age) + " ago"} ` +
          `(expected every ${ago(interval_seconds * 1000)}, alert at ${STALE_FACTOR}x)`,
      );
    } else if (!isStale && prev?.is_stale) {
      messages.push(`RECOVERED ${worker_name}: running again (last run ${ago(age)} ago)`);
    }

    // first sighting of a worker only records its error as the baseline.
    if (prev && lastError !== prev.last_error_seen) {
      messages.push(
        lastError === null
          ? `ERROR CLEARED ${worker_name}`
          : `ERROR ${worker_name}: ${lastError.slice(0, 500)}`,
      );
    }

    if (!prev || prev.is_stale !== isStale || prev.last_error_seen !== lastError) {
      updates.push({ worker_name, is_stale: isStale, last_error_seen: lastError, updated_at: new Date().toISOString() });
    }
  }

  // send first, persist state after: a telegram failure leaves state
  // untouched so the next run retries the same alerts.
  if (messages.length > 0) {
    try {
      await sendTelegram(messages.join("\n\n"));
    } catch (err) {
      return new Response(String(err), { status: 502 });
    }
  }
  if (updates.length > 0) {
    const { error } = await supabase.from("worker_alert_state").upsert(updates, { onConflict: "worker_name" });
    if (error) return new Response(error.message, { status: 500 });
  }

  return Response.json({ checked: config.data!.length, alerts: messages.length });
});
