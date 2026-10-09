# Radar de Carteiras

Rastreia carteiras da Hyperliquid, mede quais valem a pena copiar (com atraso de 1 h) e mostra
stops, liquidações, suportes e resistências dos 6 ativos (BTC, ETH, SOL, XRP, HYPE, NEAR).

- `coletor/` — Python. `coleta_hora.py` (a cada 2 h: posições, alertas, Diário, livro, ordens, painel)
  e `ranking_diario.py` (1x por dia: trades novos → operações → cópia simulada → ranking).
- `coletor/acoes.py` — ações, índices e commodities (grupo HIP-3 `xyz` da Hyperliquid): os 20 mercados mais
  líquidos, posições de até 800 carteiras e ordens de até 150 por coleta (tabelas `acoes_*`, separadas de cripto),
  Resumo e mapa de stops e liquidações. Um erro aqui não para a coleta de cripto.
  `coletor/acoes_ranking.py` (1x por dia, no laço da nuvem): ranking das carteiras só pelas operações em ações
  (mesma régua do de cripto), fluxo de 7 dias; a coleta de hora em hora fotografa essas carteiras, grava os
  alertas (com "fora do pregão" e "perto do balanço") e o Diário de cópia das confiáveis em ações (`acoes_sinais`).
  `coletor/acoes_eventos.py` (1x por dia): calendário de balanços da Nasdaq (tabela `balancos`; carga de 10 anos
  com `--historico`), reação histórica a balanços (preços do Yahoo), agenda macro dos EUA (Nasdaq; ForexFactory de
  reserva) e o teste "o contrato no fim de semana antecipa a abertura de segunda?".
- `web/` — site na Vercel: `index.html` (painel, seletor Cripto | Ações) + `api/dados.js` (lê o painel do banco, pede senha).
- `.github/workflows/` — agenda as duas coletas no GitHub Actions.

Banco: Postgres no Neon (projeto `radar-carteiras`, São Paulo; variável `DATABASE_URL`, no PC fica no `.env`). Sem ela, o coletor usa SQLite local em `data/radar2.db`.

Configuração:
- GitHub → Settings → Secrets and variables → Actions: `DATABASE_URL`
- Vercel (Root Directory `web`): `DATABASE_URL` e `PAINEL_SENHA`
