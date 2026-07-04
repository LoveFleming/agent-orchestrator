# Help Desk

A2A Protocol v0.3 — PAAW 客戶服務 Agent，透過 A2A 協議與遠端 Agent 溝通、協作。

## 架構

```
┌─────────────────────┐    A2A JSON-RPC     ┌──────────────────────┐
│  Help Desk          │ ◄──────────────────► │  PAAW Agent          │
│  (port 4100)        │    message/send      │  (port 4097)         │
│  + Agent Loop (LLM) │    push webhook      │  + Agent Loop (LLM)  │
│  + UI (聊天介面)    │                       │  + A2A Playground UI │
│  + A2A Client       │                       │  + A2A Server        │
└─────────────────────┘                       └──────────────────────┘
```

## Quick Start

```bash
# 1. Install
npm install

# 2. (Optional) Configure .env — or auto-reads PAAW's providers.json
cp .env.example .env
# edit .env

# 3. Start PAAW first (port 4097)
cd /path/to/tAgent && npm run dev

# 4. Start this server (port 4100)
npm run dev
```

## Endpoints

| Endpoint | Description |
|---|---|
| `http://localhost:4100` | UI (聊天介面) |
| `GET /.well-known/agent-card.json` | Agent Card (A2A discovery) |
| `POST /a2a/jsonrpc` | JSON-RPC endpoint |
| `POST /a2a/rest` | REST endpoint |
| `POST /a2a/webhook` | Push notification webhook |
| `GET /health` | Health check |
| `GET /api/channels` | Active chat channels |
| `GET /api/webhooks` | Received webhook events |

## 使用流程

1. 開 `http://localhost:4100` — Help Desk UI
2. 開 `http://localhost:4097` → 點「🔗 A2A Playground」— PAAW UI
3. 在任一邊輸入「跟遠端 Agent 討論 A2A 的好處」
4. 兩邊 Agent 透過 A2A 協議互相對話

## Agent Loop

- 本地對話：直接呼叫 LLM API
- 遠端協作：當訊息包含「跟遠端/協作/討論」等關鍵字時，自動：
  1. LLM 決定要問遠端 Agent 什麼
  2. 透過 A2A Client 發 message/send 到遠端
  3. LLM 整合遠端回應，回覆使用者

## Chat Channel

用 A2A 的 `contextId` 維持對話通道：
- 同一個 contextId = 同一個對話
- 兩邊 Agent 可以多輪對話
- 每次對話紀錄都保留在 channel history
