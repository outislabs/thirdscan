import { supabase } from "./supabase.js";

export async function writeWorkerStatus(workerName: string, errors: string[]): Promise<void> {
  const { error } = await supabase.from("worker_status").upsert(
    {
      worker_name: workerName,
      last_run_at: new Date().toISOString(),
      last_error: errors.length > 0 ? errors.join("; ").slice(0, 2000) : null,
    },
    { onConflict: "worker_name" },
  );
  if (error) {
    // worker_status itself failed to write; nothing left to log it to but stdout.
    console.error(`failed to write worker_status for ${workerName}: ${error.message}`);
  }
}
