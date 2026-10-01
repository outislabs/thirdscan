CREATE OR REPLACE VIEW public.v_token_registry AS
  SELECT
    chain,
    mint_address,
    token_name,
    issuer_name,
    asset_type,
    underlying_symbol,
    verified_source_url
  FROM public.rwa_issuers;

GRANT SELECT ON public.v_token_registry TO anon;
GRANT SELECT ON public.v_token_registry TO authenticated;
GRANT ALL ON public.v_token_registry TO service_role;;
