# Radar de Carteiras

Rastreia carteiras da Hyperliquid, mede quais valem a pena copiar (com atraso de 1 h) e mostra
stops, liquidações, suportes e resistências dos 6 ativos (BTC, ETH, SOL, XRP, HYPE, NEAR).

- `coletor/` — Python. `coleta_hora.py` (a cada 2 h: posições, alertas, Diário, livro, ordens, painel)
  e `ranking_diario.py` (1x por dia: trades novos → operações → cópia simulada → ranking).
- `coletor/acoes.py` — ações, índices e commodities (grupo HIP-3 `xyz` da Hyperliquid): os 20 mercados mais
  líquidos, posições de até 800 carteiras e ordens de até 150 por coleta (tabelas `acoes_*`, separadas de cripto),
  Resumo e mapa de stops e liquidações. Um erro aqui não para a coleta de cripto.
- `web/` — site na Vercel: `index.html` (painel, seletor Cripto | Ações) + `api/dados.js` (lê o painel do banco, pede senha).
- `.github/workflows/` — agenda as duas coletas no GitHub Actions.

Banco: Postgres no Neon (projeto `radar-carteiras`, São Paulo; variável `DATABASE_URL`, no PC fica no `.env`). Sem ela, o coletor usa SQLite local em `data/radar2.db`.

Configuração:
- GitHub → Settings → Secrets and variables → Actions: `DATABASE_URL`
- Vercel (Root Directory `web`): `DATABASE_URL` e `PAINEL_SENHA`
