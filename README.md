# Agent Orchestrator

A2A Protocol v0.3 — 客戶端請求入口，透過 A2A 協議調度遠端 Agent 協作。

## 定位

UI 代表**客戶端的請求**：使用者在這裡輸入需求，Orchestrator 理解後決定是否自己回答、還是調度遠端 Agent 協作。

## 架構

```
┌─────────────────────────┐    A2A JSON-RPC     ┌──────────────────────┐
│  Agent Orchestrator     │ ◄──────────────────► │  Remote Agent        │
│  (port 4100)            │    message/send      │  (port 4097)         │
│  客戶端請求入口          │    push webhook      │                      │
│  + UI (輸入需求)        │                       │  + Agent Loop (LLM)  │
│  + Agent Loop (LLM)     │                       │  + A2A Server        │
│  + A2A Client           │                       │                      │
└─────────────────────────┘                       └──────────────────────┘
```

## Quick Start

```bash
# 1. Install
npm install

# 2. (Optional) Configure .env
cp .env.example .env

# 3. Start
npm run dev
```

## Endpoints

| Endpoint | Description |
|---|---|
| `http://localhost:4100` | UI (客戶端請求入口) |
| `GET /.well-known/agent-card.json` | Agent Card (A2A discovery) |
| `POST /a2a/jsonrpc` | JSON-RPC endpoint |
| `POST /a2a/rest` | REST endpoint |
| `POST /a2a/webhook` | Push notification webhook |
| `GET /health` | Health check |
| `GET /api/channels` | Active chat channels |
| `GET /api/webhooks` | Received webhook events |

## 使用流程

1. 開 `http://localhost:4100` — Agent Orchestrator UI
2. 直接聊天，或按「💬 討論」跟遠端 Agent 對話
3. Orchestrator 會根據需求決定自己回答或調度遠端 Agent

## Agent Loop

- **本地回答**：直接呼叫 LLM API
- **遠端協作**：當訊息包含「跟遠端/協作/討論」等關鍵字時，自動：
  1. LLM 決定要問遠端 Agent 什麼
  2. 透過 A2A Client 發 message/send 到遠端
  3. LLM 整合遠端回應，回覆使用者
