# Supalive

Skill portátil para **Codex, Claude Code e Cursor**: instala, verifica e desativa um heartbeat SQL em um projeto Supabase autorizado. Node.js 20+, sem dependências em tempo de execução, sem serviço central e sem telemetria.

**Cron interno não garante impedir pausa no plano Free.** A Supabase avalia atividade de banco durante uma janela de 7 dias. Uma configuração instalada não comprova disponibilidade futura, nem execução de um job. Projeto pausado precisa ser retomado primeiro; plano pago elimina pausa automática por inatividade. [Documentação oficial](https://supabase.com/docs/guides/platform/free-project-pausing).

## Instalação da skill

Clone este repositório em uma pasta local:

```sh
git clone https://github.com/leulfonseca/supalive.git
```

Copie **a pasta inteira** `skills/supalive`, incluindo `scripts` e `sql`, para um dos destinos abaixo. Instale somente um exemplar por agente para evitar duplicidade.

| Agente | Neste projeto | Em todos os projetos deste usuário |
| --- | --- | --- |
| Codex | `.agents/skills/supalive/` | `~/.agents/skills/supalive/` |
| Claude Code | `.claude/skills/supalive/` | `~/.claude/skills/supalive/` |
| Cursor | `.cursor/skills/supalive/` | `~/.cursor/skills/supalive/` |

`~` é a pasta do usuário, inclusive no Windows. A instalação por projeto permite versionar a skill com a aplicação. Não sobrescreva uma instalação existente sem revisar suas mudanças.

Exemplo PowerShell, executado na raiz **do projeto que receberá a skill**:

```powershell
$supaliveSource = 'C:\caminho\supalive\skills\supalive'
$supaliveTarget = '.agents\skills\supalive' # Codex; ajuste para Claude Code ou Cursor
if (Test-Path -LiteralPath $supaliveTarget) { throw 'Revise a instalação existente primeiro.' }
New-Item -ItemType Directory -Path (Split-Path $supaliveTarget) -Force | Out-Null
Copy-Item -LiteralPath $supaliveSource -Destination $supaliveTarget -Recurse
```

No macOS/Linux, na raiz do projeto:

```bash
mkdir -p .agents/skills
# Confirme que .agents/skills/supalive ainda não existe.
cp -R /caminho/supalive/skills/supalive .agents/skills/supalive
```

Invocação: `$supalive` no Codex; `/supalive` no Claude Code; `/supalive` no Cursor. Se necessário, reinicie o agente após copiar a pasta. Exemplo de pedido:

> Use Supalive no projeto Supabase indicado. Quero revisar o SQL e instalar o heartbeat neste projeto. Preserve tabelas e rotinas existentes.

Destinos conferidos nas documentações de [Codex](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills), [Claude Code](https://code.claude.com/docs/en/skills#choose-where-skills-load) e [Cursor](https://cursor.com/docs/skills#skill-directories).

### Opt-in uma vez para novos projetos

Instalar a skill só a torna disponível; isso não autoriza alterar qualquer projeto Supabase. Para optar explicitamente por heartbeat ao criar projetos novos neste repositório, acrescente a regra abaixo ao `AGENTS.md` (Codex), `CLAUDE.md` (Claude Code) ou a uma regra de projeto do Cursor:

```markdown
Quando eu pedir a criação de um novo projeto Supabase neste repositório,
use a skill Supalive e instale o heartbeat no próprio projeto criado.
Este é meu opt-in para esse passo: se a criação já estiver autorizada,
não peça outra confirmação só para instalar o heartbeat.
Isso não autoriza alterar projetos preexistentes fora do pedido, gerar
cobranças, fazer upgrade ou retomar um projeto pausado.
A presença da skill sem esta regra ou autorização na conversa não autoriza mutações.
```

No Cursor, a regra pode ficar em `.cursor/rules/supalive.mdc`, com o texto acima e o cabeçalho `alwaysApply: true` no frontmatter. Preserve instruções existentes e adicione o opt-in somente se o usuário o escolher.

## O que é necessário

- `project_ref`: identificador de 20 caracteres do projeto. Em `https://<project-ref>.supabase.co`, é o trecho antes de `.supabase.co`.
- PAT scoped com **Database Read-write**, restrito ao projeto, para instalar/desativar. Para apenas consultar status, **Database Read** basta. As permissões do token não ampliam as permissões da sua conta.
- Projeto operacional, com acesso à Management API e permissão para habilitar `pg_cron`.

Esse caminho usa [POST `/v1/projects/{ref}/database/query`](https://supabase.com/docs/reference/api/v1-run-a-query), endpoint Beta/experimental. Não precisa de `anon_key`, `service_role_key` ou senha do PostgreSQL. PATs scoped limitam projetos e permissões; PAT Legacy herda acesso amplo da conta. Prefira escopo mínimo e prazo de expiração. [PATs oficiais](https://supabase.com/docs/guides/platform/personal-access-tokens).

O PAT é usado somente durante comandos remotos. Não é gravado em SQL, tabela, arquivo ou job. O heartbeat posterior usa SQL interno, sem nenhuma credencial externa.

## Uso manual

Os exemplos a seguir são executados na raiz deste repositório. Com a skill instalada, ajuste o prefixo para a pasta de instalação.

```sh
# Gera SQL revisável. Não acessa rede nem precisa de PAT.
node skills/supalive/scripts/supalive.mjs setup

# Os três comandos são offline por padrão.
node skills/supalive/scripts/supalive.mjs status
node skills/supalive/scripts/supalive.mjs disable
node skills/supalive/scripts/supalive.mjs --help
```

Para aplicar, o projeto deve estar autorizado na conversa ou pelo operador. O comando exige dois identificadores explícitos e iguais; `<project-ref>` é um placeholder que deve ser substituído.

```sh
node skills/supalive/scripts/supalive.mjs setup --apply --ref <project-ref> --confirm-ref <project-ref>
node skills/supalive/scripts/supalive.mjs status --read --ref <project-ref>
node skills/supalive/scripts/supalive.mjs disable --apply --ref <project-ref> --confirm-ref <project-ref>
```

Forneça PAT somente na variável de ambiente transitória `SUPABASE_ACCESS_TOKEN`. Não cole tokens em argumentos ou no chat. O script não lê `.env` nem a credencial salva da Supabase CLI. Exemplo PowerShell que evita colocar o valor no histórico e o remove ao terminar:

```powershell
$supalivePat = Read-Host 'PAT scoped do projeto' -AsSecureString
try {
  $env:SUPABASE_ACCESS_TOKEN = [System.Net.NetworkCredential]::new('', $supalivePat).Password
  node skills/supalive/scripts/supalive.mjs status --read --ref '<project-ref>'
  # Quando autorizado, execute setup --apply com os dois refs iguais.
} finally {
  Remove-Item Env:SUPABASE_ACCESS_TOKEN -ErrorAction SilentlyContinue
  $supalivePat.Dispose()
}
```

Em Bash, use entrada oculta e remova a variável ao concluir:

```bash
read -r -s -p 'PAT scoped do projeto: ' SUPABASE_ACCESS_TOKEN
export SUPABASE_ACCESS_TOKEN
node skills/supalive/scripts/supalive.mjs status --read --ref '<project-ref>'
unset SUPABASE_ACCESS_TOKEN
```

`status --read` executa somente consultas `SELECT` com `read_only=true`. Confere colunas, propriedade do job, banco, comando exato, agenda e `active`; não executa o heartbeat. Retorna código `0` quando o heartbeat está configurado e ativo, `1` quando há ausência, desativação, divergência ou falha. `disable --apply` retorna `0` quando confirma o job próprio inativo.

Não são impressos tokens, corpos de erro remotos nem comandos SQL desconhecidos encontrados no banco. Falhas de rede não têm retry automático: uma escrita pode ter sido aplicada mesmo após timeout. Consulte status antes de repetir.

## Comportamento no banco

- Job: `supalive-keep-alive`, agenda `0 */6 * * *` (a cada 6 horas).
- Tabela nova: `public.keep_alive(id bigint GENERATED ALWAYS AS IDENTITY, ping_time timestamptz)`, RLS habilitada e privilégios de `PUBLIC`, `anon` e `authenticated` revogados na tabela e na sequência de identidade real. Uma sequência homônima preexistente permanece intacta. Não cria políticas públicas.
- Tabela criada pelo Supalive recebe um registro por execução e limpa seus registros com mais de 7 dias. Uma marca de propriedade é verificada também em cada execução.
- Tabela preexistente compatível é **somente consultada**. Schema, dados, políticas, grants e comentários são preservados. Colunas extras são aceitas, pois não há INSERT nesse modo.
- Tabela incompatível ou cron de mesmo nome com comando, proprietário ou banco diferente causa erro e rollback. Nenhum objeto é apagado para resolver conflitos.
- Reinstalação reconhecida reusa o mesmo job, corrige sua agenda e o ativa. Outros crons permanecem intactos. `disable` só inativa o job reconhecido; não remove tabela, extensão, dados ou outros jobs.

Antes de cada INSERT/DELETE em tabela própria, o heartbeat trava a tabela e verifica novamente sua marca, colunas, identidade, default e RLS. Recusa tabelas com FKs, CHECKs ou outras constraints adicionais, rules, triggers de aplicação, herança/partições, índices adicionais/com expressões, políticas adicionais, FORCE RLS e permissões públicas. Isso evita que retenção própria alcance dados de aplicações por cascata ou código agregado à tabela. Divergências exigem revisão; o script não adapta esses objetos automaticamente. O status também sinaliza essa incompatibilidade.

O SQL usa transação e trava para serializar instalações Supalive. Não remove ou limpa o histórico global de `cron.job_run_details`. Não inclui PAT em funções, `pg_net`, HTTP, Vault ou cron. [Supabase Cron](https://supabase.com/docs/guides/cron), [instalação](https://supabase.com/docs/guides/cron/install) e [operações de jobs](https://supabase.com/docs/guides/cron/quickstart).

## Usar o fluxo de migrations existente

Em projetos que versionam mudanças do banco, gere uma migration local, sem PAT:

```sh
node skills/supalive/scripts/supalive.mjs setup > supabase/migrations/<timestamp>_supalive.sql
```

Crie antes a pasta caso ainda não exista e substitua `<timestamp>` por um nome válido no seu fluxo. O comando apenas gera um arquivo SQL; não aplica nem comita. Revise-o e use o executor de migrations já escolhido. Se o executor envolver cada migration em uma transação, adapte somente `BEGIN`/`COMMIT` externos para evitar transações aninhadas; preserve todas as guardas. O arquivo pode ser commitado porque não contém credenciais.

## Monitoramento externo opcional

Um monitor externo, como uma aba administrativa Forgy, pode inspecionar disponibilidade e gerar consultas reais periodicamente. Ele continua operando mesmo se um projeto Supabase parar. Esse monitor é uma escolha separada: esta skill não registra projetos em serviços, não chama domínios Forgy e não transmite dados ou credenciais a terceiros.

## Validação local

```sh
npm test
```

Testes de CLI usam respostas simuladas para verificar destino fixo, confirmação do projeto, ausência de rede no modo padrão, verificação de configuração e não exposição de credenciais.

Validação SQL opcional, somente local:

```sh
npm install --no-save --package-lock=false @electric-sql/pglite
npm run test:sql
```

Essa dependência é apenas para desenvolvimento. Os testes executam PostgreSQL embutido para verificar transações, RLS, idempotência, preservação de tabelas/jobs e limpeza de dados próprios. PGlite não fornece `pg_cron`: a criação da extensão é omitida e as funções de agendamento são simuladas. Isso não valida instalação real da extensão ou disparo do scheduler na Supabase. Nenhum teste remoto é executado automaticamente.

Licença [MIT](LICENSE).
