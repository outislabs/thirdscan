CREATE TABLE public.early_access_signups (
  id uuid not null default gen_random_uuid() primary key,
  email text not null unique,
  created_at timestamp with time zone not null default now()
);

GRANT INSERT ON public.early_access_signups TO anon;
GRANT INSERT ON public.early_access_signups TO authenticated;
GRANT ALL ON public.early_access_signups TO service_role;

ALTER TABLE public.early_access_signups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can request early access"
  ON public.early_access_signups
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);;
