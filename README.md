# AM-07 Electrical Hub

Central da equipe de elétrica da UFPR Fórmula para reunir ferramentas de eletrônica e alta tensão, análises do AM-07 e materiais de apresentação.

## Como abrir

1. Clone ou baixe este repositório e abra a pasta inteira no VS Code.
2. Com a extensão **Live Server** instalada, clique com o botão direito em `index.html` e escolha **Open with Live Server**.
3. Use o menu da Central para acessar **Ferramentas**, **Design**, **Cost**, **Inventário** ou **Telemetria**.

A telemetria funciona em modo simulado pelo Live Server e no GitHub Pages. Para ler o inversor ao vivo no Windows:

1. No computador conectado à MCU, execute `telemetria/Abrir_Telemetria_Inversor.bat`. Ele abre a página de telemetria local em `http://127.0.0.1:8791`. Mantenha a janela do receptor aberta durante a leitura.
2. Em **Dinâmica**, clique em **Usar MCU real** para abrir a bancada com dados da placa. Se estiver no GitHub Pages ou no Live Server, continue em **Abrir telemetria local**. Confira a porta COM do XDS100v2 e clique em **Conectar MCU**. O osciloscópio começa a exibir os sinais da placa.
3. Clique em **Desconectar MCU** ao terminar para liberar a COM.

O receptor usa o mesmo `foc_debug` do Gerenciador do Inversor. Os **Comandos de bancada** atuam na MCU conectada. **Rodar** e **Calibrar** ficam disponíveis em `IDLE` sem falha ativa, **Parar** solicita a parada e **Limpar falha** fica disponível em `FAULT`. Os parâmetros do firmware permanecem disponíveis para consulta.

Em **MCU real**, ajuste o **Limite de tensão de saída por eixo (V)** e clique em **Aplicar limite**. O ajuste escreve apenas `vmax_frac` e mostra o valor confirmado pela MCU. O limite em volts usa o barramento adotado pelo FOC e a faixa vai até o limite lido ao conectar. A MCU precisa estar sem falha ativa e em um estado que permita a escrita do parâmetro.

Para comandar torque, selecione **Modo torque** se a MCU estiver em velocidade. Uma referência escolhida em `IDLE` é enviada automaticamente quando a MCU entra em `RUN`. Em `RUN`, solte o slider para enviar o valor. O Hub converte Nm em `iq_ref` com os pares de polos e o fluxo informados pela MCU e usa os limites de corrente lidos do firmware.

Em **Enfraquecimento de campo**, acompanhe a contribuição de corrente `fw_id`, a tensão solicitada `|Vdq|` e o limiar que o firmware calcula para o regulador. A linha tracejada mostra esse limiar. Os gráficos exibem as últimas 60 leituras da telemetria.

Se o Gerenciador estiver conectado, desconecte-o para liberar a porta. Caso o FOC esteja em outra pasta, passe a pasta `host` do FOC como argumento ao arquivo `.bat`.

Para iniciar o receptor ao entrar no Windows, coloque um atalho para `Abrir_Telemetria_Inversor.bat` na pasta `shell:startup`. Acrescente `--so-receptor` ao destino do atalho para iniciar sem abrir o navegador. Se o atalho também informar a pasta `host`, coloque `--so-receptor` antes desse caminho.

O checklist de energização está em rascunho para revisão pela equipe.

## Inventário compartilhado

O inventário está conectado ao Firebase Realtime Database do projeto `inventario-am-07`. O provedor é selecionado em `inventario/cloud-config.js`, que também aceita Supabase. Sem um provedor configurado, os dados ficam no navegador.

### Firebase Realtime Database

1. Baixe um **Backup JSON** do estoque atual antes de trocar o provedor.
2. Crie um Realtime Database no projeto Firebase e publique as regras de `inventario/firebase.rules.json`. Pelo Firebase CLI, use `firebase deploy --only database --project ID_DO_PROJETO` na pasta do Hub.
3. Importe o estoque atual em `/am07Inventory/stock`, com `schemaVersion: 3`, `revision` maior que zero e `items`. A primeira abertura de um banco vazio carrega os componentes iniciais do repositório.
4. Em `inventario/cloud-config.js`, selecione `provider: "firebase"` e preencha `databaseURL` com a URL exibida no Realtime Database. Publique o site depois de conferir a importação.

As regras mantêm o inventário compartilhado por link. Quem tem o link pode consultar e editar componentes e PDFs. O restante do banco fica fechado. As gravações usam uma revisão e uma condição de versão para proteger alterações simultâneas. Os ajustes de quantidade fazem até cinco tentativas em caso de conflito. Os PDFs continuam limitados a 10 MB e ficam separados dos dados do estoque. A consulta periódica baixa apenas a revisão quando os componentes continuam iguais.

### Supabase

Para configurar um projeto Supabase:

1. Antes de ativar, baixe um **Backup JSON** em cada navegador que já tenha cadastros para migrar.
2. Crie um projeto no Supabase e execute `inventario/supabase.sql` no **SQL Editor**.
3. Em `inventario/cloud-config.js`, selecione `provider: "supabase"` e preencha o **Project URL** e a **Publishable key** (prefixo `sb_publishable_`) do diálogo **Connect**. Esses dois valores podem ser publicados no GitHub Pages. Guarde as chaves secretas e a senha do banco no Supabase.
4. Publique o site e abra a página **Inventário**. O primeiro acesso carrega os componentes iniciais. Use **Importar JSON** para migrar seus backups. A opção de adicionar itens novos ignora itens que já existem. Para migrar também alterações de quantidade ou anexos de itens existentes, use como base o backup completo do navegador que tem o estoque correto e confirme a substituição.

O estoque é consultado ao voltar para a página e a cada 15 segundos enquanto ela está visível. Ajustes pelos botões de quantidade são aplicados no banco, e formulários ou importações com uma revisão antiga recebem um aviso de conflito. Qualquer pessoa com acesso ao site pode consultar e editar o inventário, inclusive baixar fichas técnicas e excluir componentes. Para atualizar um projeto existente, execute novamente o SQL do passo 2. O script apaga as fotos antigas do catálogo no Supabase e preserva os componentes, saldos e datasheets em PDF.

## Cost de HV e EL

A área `cost/` preserva os 113 registros de HV e EL da aba `01. Track Parts`, com códigos, códigos pais, tipos e metadados originais. Os ancestrais necessários de outras gerências aparecem somente como contexto e não entram no custo. A necessidade para um carro multiplica a quantidade por todas as quantidades dos pais. Conjuntos com quantidade em branco precisam ser preenchidos em **Editar quantidade**.

Em **Editar / vincular**, escolha um item existente do inventário, informe conversão de unidades quando necessária e preencha o custo unitário ou use o preço conhecido do inventário. Um código único e exatamente igual permite associação automática. O mesmo item pode atender várias linhas, e sua demanda é somada entre HV e EL antes de conferir o saldo. A associação não reserva nem altera o estoque. As alterações do planejamento ficam compartilhadas em `/am07Cost/plan`, com revisão e gravação condicional. O CSV exportado preserva as colunas originais e acrescenta a comparação.

No inventário, cada componente pode ser classificado como EL, HV ou ambos. Cadastros anteriores sem classificação ficam como **Não definida** até a equipe classificá-los. Os filtros incluem peças compartilhadas em ambas as gerências. O campo **Link do datasheet** aceita endereços do fabricante ou PDFs publicados no GitHub Pages.

## Organização

- `ferramentas/` reúne a curva de torque editável, o Optimum Lap, os dados de simulação e o checklist.
- `design/` reúne as vistas do AM-07 e a curva de torque para apresentação.
- `cost/` contém a estrutura de HV e EL e a comparação com o inventário.
- `inventario/` contém a página, os dados iniciais e os recursos do inventário de componentes.
- `telemetria/` contém o painel de telemetria do AM-07.
- `imagens/` e `estilos/` guardam os recursos visuais compartilhados.
