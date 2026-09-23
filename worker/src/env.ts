import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string): string | null {
  return process.env[name] || null;
}

export const env = {
  SUPABASE_URL: required("SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: required("SUPABASE_SERVICE_ROLE_KEY"),
  // optional, not required: holders.ts fails its own cycle (worker_status
  // error) rather than crash the whole process when this is unset, so the
  // other jobs keep running without a helius key.
  HELIUS_API_KEY: optional("HELIUS_API_KEY"),
  // optional: jupiter.ts uses the keyless lite-api.jup.ag endpoint when
  // this is unset, and api.jup.ag (with this as x-api-key) when it is.
  JUP_API_KEY: optional("JUP_API_KEY"),
};
