# AM-07 Electrical Hub

Central da equipe de elétrica da UFPR Fórmula para reunir ferramentas de eletrônica e alta tensão, análises do AM-07 e materiais de apresentação.

## Como abrir

1. Clone ou baixe este repositório e abra a pasta inteira no VS Code.
2. Com a extensão **Live Server** instalada, clique com o botão direito em `index.html` e escolha **Open with Live Server**.
3. Use o menu da Central para acessar **Ferramentas**, **Design & Cost**, **Inventário** ou **Telemetria**.

A telemetria pode ser explorada em modo simulado. A leitura ao vivo do inversor exige o receptor local configurado separadamente. O checklist de energização está em rascunho para revisão pela equipe.

## Inventário compartilhado

O inventário usa o navegador enquanto a URL e a chave publicável estiverem vazias em `inventario/cloud-config.js`. Para usar o mesmo estoque no celular e no computador:

1. Antes de ativar, baixe um **Backup JSON** em cada navegador que já tenha cadastros para migrar.
2. Crie um projeto no Supabase e execute `inventario/supabase.sql` no **SQL Editor**.
3. Preencha `inventario/cloud-config.js` com o **Project URL** e a **Publishable key** (prefixo `sb_publishable_`) do diálogo **Connect**. Esses dois valores podem ser publicados no GitHub Pages. Guarde as chaves secretas e a senha do banco no Supabase.
4. Publique o site e abra a página **Inventário**. O primeiro acesso carrega os componentes iniciais. Use **Importar JSON** para migrar seus backups. A opção de adicionar itens novos ignora itens que já existem. Para migrar também alterações de quantidade ou anexos de itens existentes, use como base o backup completo do navegador que tem o estoque correto e confirme a substituição.

O estoque é consultado ao voltar para a página e a cada 15 segundos enquanto ela está visível. Ajustes pelos botões de quantidade são aplicados no banco, e formulários ou importações com uma revisão antiga recebem um aviso de conflito. Qualquer pessoa com acesso ao site pode consultar e editar o inventário, inclusive baixar anexos e excluir componentes. Para atualizar um projeto existente, execute novamente o SQL do passo 2. O script preserva o estoque existente.

## Organização

- `ferramentas/` reúne a curva de torque editável, o Optimum Lap, os dados de simulação e o checklist.
- `design/` reúne as vistas do AM-07 e a curva de torque para apresentação.
- `inventario/` contém a página, os dados iniciais e os recursos do inventário de componentes.
- `telemetria/` contém o painel de telemetria do AM-07.
- `imagens/` e `estilos/` guardam os recursos visuais compartilhados.
