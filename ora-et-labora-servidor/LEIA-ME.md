# Ora et Labora — como colocar no ar para a equipe

Esta pasta é a versão de servidor do Ora et Labora. No servidor:

- cada pessoa entra com o próprio nome e uma senha;
- missões, reuniões, clientes, criativos, anexos e a cidade são os mesmos para todo mundo;
- a **Minha área** de cada um (missões pessoais, hábitos, revisão semanal, exame do dia e intenções) só aparece para o dono. O servidor nem envia esses dados para os outros;
- o resumo diário chega no WhatsApp de cada pessoa, no horário que ela escolher.

Não precisa de banco de dados. Tudo fica num arquivo (`ora.json`) e numa pasta de anexos, dentro de um disco do servidor. Uma cópia de segurança é feita todo dia e as últimas 14 ficam guardadas.

---

## Passo a passo (Railway + GitHub)

O Railway é um serviço que roda o Ora et Labora na internet. O plano Hobby custa **US$ 5 por mês**, valor que já inclui US$ 5 de uso. Para uma equipe de 3 pessoas, esse uso costuma bastar. Contas novas ganham US$ 5 de teste.

### 1. Suba esta pasta para o GitHub

1. Crie uma conta em <https://github.com> (se ainda não tiver).
2. Clique em **New repository**, dê o nome `ora-et-labora`, marque **Private** e clique em **Create repository**.
3. Na página do repositório, clique em **uploading an existing file**.
4. Arraste **o conteúdo** desta pasta: `servidor.js`, `package.json`, `.gitignore`, `LEIA-ME.md` e a pasta `publico`. A pasta `node_modules` não vai, e o pacote já veio sem ela.
5. Clique em **Commit changes**.

### 2. Crie o projeto no Railway

1. Entre em <https://railway.com> com a sua conta do GitHub.
2. Clique em **New Project → Deploy from GitHub repo** e escolha `ora-et-labora`.
3. O Railway reconhece sozinho que é Node.js e começa a instalar.

### 3. Crie o disco onde ficam os dados (obrigatório)

Sem disco, os dados se perdem a cada atualização.

1. No projeto, clique com o botão direito no fundo da tela (ou aperte `Ctrl+K`) e escolha **Volume**.
2. Ligue o volume ao serviço `ora-et-labora`.
3. Em **Mount path**, escreva `/data`.

O servidor encontra o disco sozinho. Não precisa configurar mais nada.

### 4. Gere o endereço

1. Clique no serviço e vá em **Settings → Networking → Generate Domain**.
2. Vai aparecer algo como `ora-et-labora-production.up.railway.app`. Esse é o endereço da equipe.
3. Se quiser um endereço próprio, como `missoes.agenciacrown.com.br`, use **Custom Domain** no mesmo lugar e siga as instruções de DNS que o Railway mostrar.

### 5. Primeiro acesso

1. Abra o endereço. Na primeira vez, ele pede para **criar a conta do administrador**: use seu nome e uma senha.
2. Vá em **Ajustes → Equipe** e adicione cada colaborador com um nome e uma senha inicial.
3. Mande para cada um o endereço, o nome e a senha. Cada pessoa troca a própria senha em **Ajustes → Sua conta**.

### 6. Resumo diário no WhatsApp

O servidor precisa de um número de WhatsApp que envia as mensagens. Use um número da agência, não o seu pessoal. Escolha **uma** das opções abaixo.

**Opção A — Z-API (mais simples, pago)**

1. Crie conta em <https://www.z-api.io>. Custa cerca de R$ 99,99 por mês por número, com 2 dias grátis para testar.
2. Crie uma instância e leia o QR Code com o WhatsApp do número da agência.
3. No painel da Z-API, copie o **ID da instância**, o **Token** e o **Client-Token**. O Client-Token fica em Segurança.
4. No Railway, abra o serviço, vá em **Variables** e adicione:

| Variável | Valor |
|---|---|
| `ZAPI_INSTANCIA` | ID da instância |
| `ZAPI_TOKEN` | Token da instância |
| `ZAPI_CLIENT_TOKEN` | Client-Token da conta |

**Opção B — Evolution API (gratuita, mais técnica)**

Se você já tem uma Evolution API (versão 2) rodando, adicione estas variáveis:

| Variável | Valor |
|---|---|
| `EVOLUTION_URL` | endereço da sua Evolution, ex.: `https://evo.suaagencia.com` |
| `EVOLUTION_INSTANCIA` | nome da instância |
| `EVOLUTION_CHAVE` | a apikey |

Depois de salvar as variáveis, o Railway reinicia sozinho. Então cada pessoa:

1. abre **Minha área → Resumo diário no WhatsApp**;
2. informa o número com DDD, escolhe o horário e marca a caixinha;
3. clica em **Enviar teste** para conferir.

A mensagem traz as reuniões do dia, as missões de hoje, as atrasadas, o que espera aprovação, os ajustes pedidos, as missões pessoais e os hábitos. Cada pessoa recebe só as dela.

> As duas opções conectam um WhatsApp comum, pelo mesmo caminho do WhatsApp Web, e não pela API oficial da Meta. Para 3 pessoas recebendo 1 mensagem por dia o risco é baixo, mas use um número da agência.

---

## Variáveis opcionais

| Variável | Para quê | Padrão |
|---|---|---|
| `FUSO` | fuso horário do resumo diário | `America/Sao_Paulo` |
| `APP_URL` | endereço que aparece no fim do resumo | o domínio gerado pelo Railway |
| `ORA_DADOS` | pasta dos dados, se não usar volume do Railway | `./dados` |

## Como atualizar depois

Quando houver uma versão nova do Ora et Labora:

1. abra o repositório no GitHub;
2. entre na pasta `publico`, clique em `index.html` e depois no lápis (ou em **Add file → Upload files**);
3. troque o arquivo e faça o commit.

O Railway publica a nova versão sozinho em um ou dois minutos, e os dados continuam no disco.

## Cópias de segurança

- Toda madrugada fica uma cópia em `/data/backups/ora-AAAA-MM-DD.json`, e as últimas 14 são guardadas.
- Para baixar uma cópia, use a aba **Volume** do serviço no Railway.

## Rodar no próprio computador (opcional)

Precisa do Node.js 20 ou mais novo. Na pasta, rode:

```
npm install
npm start
```

Depois abra <http://localhost:3000>.

## Google Drive na versão de servidor

Na versão publicada pelo Claude, o botão **Do Google Drive** busca arquivos direto no seu Drive. No servidor próprio, essa busca depende da conexão do Claude, que não existe lá. Por isso, o botão vira **colar link do Drive**: abra o arquivo no Drive, copie o link e cole. O anexo fica clicável para toda a equipe, conforme as permissões do arquivo no Drive.
