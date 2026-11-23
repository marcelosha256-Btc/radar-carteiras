-- Rode no SQL Editor do Supabase (projeto que será do radar). Troque SENHA_FORTE_AQUI por uma senha nova (só letras e números evita problemas na URL).
create schema if not exists radar;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'radar_app') then
    create role radar_app login password 'SENHA_FORTE_AQUI';
  end if;
end $$;
grant usage, create on schema radar to radar_app;
alter role radar_app set search_path = radar;      -- as tabelas do radar ficam sempre no schema "radar"
alter role radar_app set statement_timeout = '120s';
-- radar_app não enxerga nada fora do schema radar (o que for do Vault continua separado)
revoke all on schema public from radar_app;
