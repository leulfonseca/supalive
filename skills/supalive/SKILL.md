---
name: supalive
description: Use when creating a Supabase project and the user opts into a keepalive heartbeat, or when asked to install, inspect, or disable Supalive for a specified Supabase project. Do not activate for unrelated database migrations or promise Free plan availability.
---

# Supalive

Instale uma rotina local ao banco somente quando o usuário escolher keepalive.
Não altere o provedor nem o fluxo de migrations escolhido no projeto.

## Escopo e credenciais

- Identifique o `project_ref` de 20 caracteres. Uma URL customizada não substitui esse identificador.
- PAT scoped com **Database Read-write**, limitado ao projeto, basta para criar tabela e cron pela Management API. Status aceita Database Read. O papel da conta também deve permitir a operação. PAT Legacy tem acesso amplo à conta.
- Receba PAT somente em `SUPABASE_ACCESS_TOKEN`, na memória do processo. Não peça token no chat; não escreva em argumentos, SQL, migrations, arquivos, logs ou jobs. O cron executa SQL interno, sem token em tempo de execução.
- Autorização já dada na conversa para instalar neste projeto é suficiente. Sem essa autorização, prepare SQL revisável e peça confirmação antes de aplicar. Criar projeto não autoriza cobrança, upgrade, retomar projeto pausado ou modificar outro projeto.
- Um opt-in explícito em `AGENTS.md`, `CLAUDE.md` ou regra Cursor pode incluir o heartbeat na criação solicitada de novos projetos. Nesse escopo já autorizado, execute sem nova pergunta. A mera instalação da skill não constitui opt-in.

## Executar

Resolva `scripts/supalive.mjs` relativamente a esta pasta; requer Node.js 20+.

```sh
# Padrão: somente SQL, sem rede e sem token.
node <skill-dir>/scripts/supalive.mjs setup

# Inspeção remota: somente SELECT, read_only=true.
node <skill-dir>/scripts/supalive.mjs status --read --ref <project-ref>

# Após autorização do projeto e revisão do SQL:
node <skill-dir>/scripts/supalive.mjs setup --apply --ref <project-ref> --confirm-ref <project-ref>

# Desativar somente o job reconhecido; manter tabela e dados.
node <skill-dir>/scripts/supalive.mjs disable --apply --ref <project-ref> --confirm-ref <project-ref>
```

Se o projeto usa migrations, gere SQL com o comando offline e registre uma migration pelo mecanismo existente. Não acrescente outra transação quando o executor já gerenciar transações; revise essa adaptação sem remover as verificações. Nunca comite PAT.

## Invariantes

Setup transacional cria `public.keep_alive` e job `supalive-keep-alive`, a cada 6 horas. Tabela nova tem RLS e nenhum grant/policy para `anon` ou `authenticated`. Somente tabela marcada como criada pelo Supalive recebe INSERT e limpeza de registros com mais de 7 dias.

Tabela preexistente precisa conter `id bigint` e `ping_time timestamptz`; permanece com schema, políticas, grants e dados intactos. Nesse caso o job apenas consulta a tabela. Não adote tabela incompatível, nem cron com nome igual e comando/proprietário/banco desconhecidos. O script falha nesses conflitos; apresente o diagnóstico, sem apagar ou substituir objetos.

Em tabela própria, cada execução trava e revalida schema/defaults/identity/RLS, grants e dependências. Recusa FKs, CHECKs, rules, triggers de aplicação, herança/partições, políticas adicionais/FORCE RLS e índices adicionais/com expressão antes de qualquer escrita/limpeza. Não remova essas guardas para contornar incompatibilidade.

Depois de aplicar, o script verifica shape, comando, proprietário, banco, agenda e `active`. Relate configuração instalada separadamente de execução observada. Em timeout/erro ambíguo, use status antes de repetir; não faça retries cegos.

**Cron interno não garante impedir pausa no Free.** Banco pausado precisa ser retomado primeiro. Só plano pago elimina pausa automática por inatividade. Não anuncie garantia de disponibilidade. Monitor externo, como o admin Forgy, é opcional e exige configuração separada; esta skill não o contata nem envia telemetria.

Fontes: [PAT](https://supabase.com/docs/guides/platform/personal-access-tokens), [SQL API](https://supabase.com/docs/reference/api/v1-run-a-query), [Cron](https://supabase.com/docs/guides/cron), [pausa](https://supabase.com/docs/guides/platform/free-project-pausing).
