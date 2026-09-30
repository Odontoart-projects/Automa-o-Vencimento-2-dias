# Odontoart — Tratador de Campanhas

Aplicação web estática para transformar os relatórios brutos de campanha da Odontoart no padrão de CSV utilizado para disparos.

## Regras implementadas

1. Ordena o resultado em ordem alfabética pelo nome do cliente.
2. Lê `Telefone 1`, `Telefone 2` e `Telefone 3` individualmente.
3. Remove caracteres não numéricos apenas para validar/normalizar o telefone.
4. Descarta apenas telefones com menos de 11 dígitos.
5. Mantém clientes repetidos e telefones repetidos.
6. Cada telefone válido gera uma linha própria.
7. Mapeamento do relatório bruto:
   - `Nome` → `COLC`
   - `Data` → `COLE`
   - `Valor` → ` COLG `
   - `Informação Adicional 1` → `COLI`
8. Campos fixos do CSV:
   - `COLB`: `ODONTOART: Ola`
   - `COLD`: `Venc.`
   - `COLF`: `Valor`
   - `COLH`: `Cod Barras:`
   - `COLJ`: `Ou no site: `
   - `COLK`: `https://bit.ly/3jMnw1r`

## Segurança

- Processamento 100% no navegador; não existe backend.
- `connect-src 'none'`: a página não pode fazer requisições de rede.
- Nenhuma biblioteca externa ou CDN.
- Dados da prévia são inseridos com `textContent` para evitar injeção de HTML.
- CSV exportado aplica mitigação de CSV/Formula Injection para células iniciadas por `=`, `+`, `-`, `@`, tab ou carriage return.
- Limite de 15 MB por arquivo e 50.000 registros por arquivo.
- Arquivos suportados: relatórios `.xls` da origem atual (HTML exportado pelo sistema) e `.csv`.

## Execução local

A opção recomendada é servir a pasta em um servidor estático local:

```bash
python -m http.server 8080
```

Depois abra `http://localhost:8080` no navegador.

Também pode ser hospedado como site estático em servidor interno, Vercel, Netlify, Nginx ou Apache. Como não há backend, os dados permanecem no navegador do usuário durante o processamento.

## Estrutura

- `index.html` — interface
- `styles.css` — design responsivo
- `app.js` — leitura, validação, transformação, prévia e exportação


## Correção de exportação por origem (v3)
- Ortodontia e Operadora são separados em conjuntos independentes no momento do processamento.
- O botão de uma origem não filtra mais o consolidado no momento do download.
- O nome do arquivo inclui a quantidade exportada para facilitar conferência.
- O JavaScript possui versionamento para reduzir risco de cache de versão anterior.


## v5
- Layout inicial compactado dinamicamente conforme a altura da tela.
- Melhor aproveitamento do primeiro viewport em notebooks e janelas baixas.
- Rolagem inercial por roda do mouse no desktop.
- Áreas com rolagem própria, como a tabela, permanecem independentes.
- Respeita prefers-reduced-motion e mantém touch nativo.
