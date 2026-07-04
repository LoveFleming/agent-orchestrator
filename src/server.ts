/**
 * Agent Orchestrator — Agent2Agent Protocol Client
 *
 * 功能：
 *   1. 客戶端 UI — 使用者輸入請求的入口
 *   2. A2A Server — 暴露 Agent Card + JSON-RPC
 *   3. Agent Loop — 接 LLM API，理解需求並調度遠端 Agent
 *   4. A2A Client — 主動呼叫遠端 Agent，建立聊天通道
 *   5. Webhook — 接收遠端 Agent 的 push notification
 */

import 'dotenv/config';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AgentCard, AGENT_CARD_PATH, Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from '@a2a-js/sdk';
import {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
  DefaultRequestHandler,
  InMemoryTaskStore,
  InMemoryPushNotificationStore,
  DefaultPushNotificationSender,
} from '@a2a-js/sdk/server';
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';

// ════════════════════════════════════════════════════════
// Config
// ════════════════════════════════════════════════════════

const PORT = parseInt(process.env.A2A_PORT || '4100');
const REMOTE_AGENT_URL = process.env.REMOTE_AGENT_URL || 'http://localhost:4097';

// LLM Provider (use .env or auto-detect sibling providers.json)
const LLM_BASE_URL = process.env.LLM_BASE_URL || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'glm-5.1';

// ════════════════════════════════════════════════════════
// 1b. Remote Agent Card Discovery
// ════════════════════════════════════════════════════════

interface RemoteSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  endpoints?: Record<string, string>;
}

let remoteSkills: RemoteSkill[] = [];
let remoteAgentName = 'Remote Agent';

async function discoverRemoteAgent() {
  try {
    const res = await fetch(`${REMOTE_AGENT_URL}/.well-known/agent.json`);
    if (!res.ok) { console.log(`[Discovery] Agent Card fetch failed: ${res.status}`); return; }
    const card = await res.json() as any;
    remoteAgentName = card.name || 'Remote Agent';
    remoteSkills = (card.skills || []).map((s: any) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags || [],
      endpoints: s.endpoints,
    }));
    console.log(`[Discovery] ${remoteAgentName} has ${remoteSkills.length} skills:`);
    for (const s of remoteSkills) {
      console.log(`  - ${s.id}: ${s.name} (${s.tags.join(', ')})`);
    }
  } catch (err: any) {
    console.log(`[Discovery] Failed to fetch Agent Card: ${err.message}`);
  }
}

function buildSkillsDescription(): string {
  if (remoteSkills.length === 0) return '';
  const lines = remoteSkills.map(s => `  - ${s.id} (${s.name}): ${s.description}`);
  return `\n遠端 Agent (${remoteAgentName}) 提供以下 skills：\n${lines.join('\n')}\n`;
}

// Resolve paths relative to this file
import { fileURLToPath as _fileURLToPath } from 'url';
import { dirname as _dirname, resolve as _resolve } from 'path';
const _thisDir = _dirname(_fileURLToPath(import.meta.url));

// Try to load from sibling config (e.g. ../data/config/providers.json)
let providerConfig: any = null;
try {
  const fs = await import('fs');
  const candidates = [
    _resolve(_thisDir, '../../../tPAAW/data/config/providers.json'),
    _resolve(_thisDir, '../../tPAAW/data/config/providers.json'),
    _resolve(process.cwd(), '../tPAAW/data/config/providers.json'),
    _resolve(process.cwd(), 'data/config/providers.json'),
  ];
  const configPath = candidates.find(p => fs.existsSync(p));
  if (configPath) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    providerConfig = JSON.parse(raw);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  providerConfig = JSON.parse(raw);
} catch {}


function getLLMConfig() {
  if (LLM_BASE_URL && LLM_API_KEY) {
    return { baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY, model: LLM_MODEL };
  }
  if (providerConfig) {
    const active = providerConfig.active;
    const provider = providerConfig.providers[active];
    return {
      baseURL: provider?.baseURL || '',
      apiKey: provider?.apiKey || '',
      model: providerConfig.defaultModel || 'glm-5.1',
      providerId: active,
    };
  }
  return null;
}

// ════════════════════════════════════════════════════════
// 1. Agent Card
// ════════════════════════════════════════════════════════

const AGENT_CARD: AgentCard = {
  name: 'Agent Orchestrator',
  description: 'Agent Orchestrator — 客戶端請求入口，透過 A2A 協議調度遠端 Agent 協作',
  protocolVersion: '0.3.0',
  version: '1.0.0',
  url: `http://localhost:${PORT}/a2a/jsonrpc`,
  skills: [
    {
      id: 'chat',
      name: '聊天',
      description: '自然語言對話，可以討論任何話題',
      tags: ['chat', 'conversation'],
    },
    {
      id: 'collaborate',
      name: '協作',
      description: '透過 A2A 協議與遠端 Agent 協作完成任務',
      tags: ['collaborate', 'a2a', 'remote'],
    },
  ],
  capabilities: {
    streaming: true,
    pushNotifications: true,
    stateTransitionHistory: true,
  },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  additionalInterfaces: [
    { url: `http://localhost:${PORT}/a2a/jsonrpc`, transport: 'JSONRPC' },
    { url: `http://localhost:${PORT}/a2a/rest`, transport: 'HTTP+JSON' },
  ],
};

// ════════════════════════════════════════════════════════
// 2. LLM Agent Loop
// ════════════════════════════════════════════════════════

function buildSystemPrompt(): string {
return `你是 Agent Orchestrator，一個友善的 AI 助手。你是客戶端的請求入口，負責理解使用者需求，決定自己回答還是調度遠端 Agent。

${buildSkillsDescription()}
## 路由規則

你會根據使用者問題的類型，決定是否需要遠端 Agent：

1. **關於 PAAW 的問題**（功能、架構、用法、操作、問題回報）→ 呼叫遠端 Agent 的 HelpDesk skill
2. **需要執行 PAAW skill**（翻譯、筆記、待辦等）→ 呼叫遠端 Agent
3. **一般聊天、知識問答、翻譯**→ 你自己回答
4. **不確定**→ 自己先回答，必要時再找遠端

## 如何呼叫遠端

當你需要遠端 Agent 時，在你的回答開頭加上：

[REMOTE: 你的問題]

系統會自動把問題送到遠端 Agent，收到回應後，你會看到：

[REMOTE_RESPONSE: 遠端的回答]

然後你根據遠端回答，用中文整理給使用者。引用遠端內容時請標註出處。

## 回答風格

簡潔、友善、用中文。能自己回答的不要找遠端。`;
}

async function callLLM(messages: Array<{ role: string; content: string }>): Promise<string> {
  const config = getLLMConfig();
  if (!config) throw new Error('No LLM provider configured. Set .env or ensure providers.json exists.');

  const baseURL = config.baseURL.replace(/\/+$/, '');
  const extraHeaders: Record<string, string> = {};
  if (config.providerId === 'openrouter') {
    extraHeaders['HTTP-Referer'] = 'https://agent-orchestrator.ai';
    extraHeaders['X-Title'] = 'Agent Orchestrator';
  }

  const body = {
    model: config.model,
    messages,
    stream: false,
    temperature: 0.7,
    max_tokens: 2000,
  };

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '(empty response)';
}

// ════════════════════════════════════════════════════════
// 3. A2A Client — 呼叫遠端 Agent
// ════════════════════════════════════════════════════════

interface ChatChannel {
  contextId: string;
  remoteAgentUrl: string;
  history: Array<{ role: string; text: string; timestamp: string }>;
}

// Active chat channels (in-memory)
const chatChannels = new Map<string, ChatChannel>();

async function sendToRemoteAgent(text: string, contextId?: string): Promise<{ response: string; contextId: string }> {
  const remoteEndpoint = `${REMOTE_AGENT_URL}/a2a`;
  const cid = contextId || `ctx-${Date.now()}`;

  try {
    const res = await fetch(remoteEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text }],
            messageId: `msg-${uuidv4()}`,
          },
          ...(cid ? { contextId: cid } : {}),
        },
        id: `remote-${Date.now()}`,
      }),
    });

    if (!res.ok) throw new Error(`Remote agent HTTP ${res.status}`);
    const data = await res.json() as any;

    if (data.error) throw new Error(data.error.message || 'Remote agent error');

    const task = data.result;
    let responseText = '';

    if (task?.artifacts?.[0]?.parts?.[0]?.text) {
      responseText = task.artifacts[0].parts[0].text;
    } else if (task?.history) {
      const lastAgent = [...task.history].reverse().find((m: any) => m.role === 'agent');
      if (lastAgent?.parts?.[0]?.text) responseText = lastAgent.parts[0].text;
    } else if (task?.status?.message?.parts?.[0]?.text) {
      responseText = task.status.message.parts[0].text;
    }

    if (!responseText) responseText = '(remote agent completed but no readable text output)';

    // Update channel
    const channel = chatChannels.get(cid) || { contextId: cid, remoteAgentUrl: REMOTE_AGENT_URL, history: [] };
    channel.history.push({ role: 'user', text, timestamp: new Date().toISOString() });
    channel.history.push({ role: 'remote', text: responseText, timestamp: new Date().toISOString() });
    chatChannels.set(cid, channel);

    return { response: responseText, contextId: cid };
  } catch (err: any) {
    console.error('[A2A Client] Error:', err.message);
    return { response: `❌ 無法連接遠端 Agent: ${err.message}`, contextId: cid };
  }
}

// ════════════════════════════════════════════════════════
// 4. Agent Executor — 真的 Agent Loop
// ════════════════════════════════════════════════════════

class RealAgentExecutor implements AgentExecutor {
  private cancelledTasks = new Set<string>();

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = requestContext;

    // Create task if needed
    if (!task) {
      eventBus.publish({
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'submitted', timestamp: new Date().toISOString() },
        history: [userMessage],
      } as Task);
    }

    // Status: WORKING
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      final: false,
    } as TaskStatusUpdateEvent);

    const userText = userMessage.parts
      .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
      .map(p => p.text)
      .join('\n');

    console.log(`[A2A] Task ${taskId}: "${userText.slice(0, 100)}"`);

    try {
      // Build messages for LLM
      const channel = chatChannels.get(contextId || '');
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: buildSystemPrompt() },
      ];

      // Add conversation history from channel if exists
      if (channel?.history.length) {
        for (const entry of channel.history.slice(-10)) {
          const prefix = entry.role === 'remote' ? '遠端 Agent 說：' : '使用者說：';
          messages.push({ role: 'user', content: `${prefix}${entry.text}` });
        }
      }

      messages.push({ role: 'user', content: userText });

      // LLM decides: answer locally or call remote?
      const SYSTEM_PROMPT = buildSystemPrompt();
      let result: string;

      // Step 1: LLM generates its response (may include [REMOTE: ...] to request remote help)
      const llmResponse = await callLLM([
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages.slice(1, -1).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user', content: userText },
      ]);

      // Check if LLM wants to call remote
      const remoteMatch = llmResponse.match(/\[REMOTE:\s*([\s\S]+?)\]/);
      if (remoteMatch) {
        const remoteQuestion = remoteMatch[1].trim();
        console.log(`[A2A] LLM requests remote: "${remoteQuestion.slice(0, 80)}"`);

        // Check if this maps to a specific skill endpoint (e.g. helpdesk)
        const helpdeskSkill = remoteSkills.find(s => s.id === 'paaw-helpdesk' || s.tags.includes('helpdesk'));
        let remoteResponse: string;

        if (helpdeskSkill?.endpoints?.ask && /paaw|help|問題|怎麼|如何|feature|architecture/i.test(remoteQuestion)) {
          // Direct HelpDesk API call (faster, uses KNOWLEDGE.md)
          console.log(`[A2A] Using HelpDesk endpoint for: "${remoteQuestion.slice(0, 60)}"`);
          try {
            const hdRes = await fetch(helpdeskSkill.endpoints.ask, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentName: 'Agent Orchestrator', agentType: 'a2a', message: remoteQuestion, subject: remoteQuestion.slice(0, 80) }),
            });
            const hdData = await hdRes.json() as any;
            if (hdData.answer) {
              remoteResponse = hdData.answer;
              console.log(`[A2A] HelpDesk answered (${hdData.answer.length} chars, ticket: ${hdData.ticketId})`);
            } else {
              remoteResponse = `HelpDesk 已記錄問題（工單 ${hdData.ticketId}），但無法自動回答。${hdData.error || ''}`;
            }
          } catch (err: any) {
            // Fallback to A2A message/send
            const remoteResult = await sendToRemoteAgent(remoteQuestion, contextId);
            remoteResponse = remoteResult.response;
          }
        } else {
          // General A2A message/send
          const remoteResult = await sendToRemoteAgent(remoteQuestion, contextId);
          remoteResponse = remoteResult.response;
        }

        // Step 2: If HelpDesk returned a full answer, pass through directly (no LLM synthesis)
        // For non-helpdesk remote calls, still use LLM synthesis
        if (helpdeskSkill?.endpoints?.ask && /paaw|help|問題|怎麼|如何|feature|architecture/i.test(remoteQuestion) && remoteResponse.length > 100 && !remoteResponse.startsWith('HelpDesk 已記錄')) {
          // HelpDesk answer — pass through as-is
          console.log(`[A2A] HelpDesk pass-through (${remoteResponse.length} chars)`);
          result = remoteResponse;
        } else {
          // General remote — LLM synthesizes final answer
          const synthesisMessages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `使用者問：「${userText}」` },
            { role: 'user', content: `你決定問遠端 Agent：「${remoteQuestion}」` },
            { role: 'user', content: `[REMOTE_RESPONSE: ${remoteResponse}]` },
            { role: 'user', content: '請根據以上資訊，用中文整理一個完整的回答給使用者。引用遠端內容請標註。不要加 [REMOTE] 標記。' },
          ];
          result = await callLLM(synthesisMessages);
        }
      } else {
        // LLM answered locally — use as-is
        result = llmResponse;
      }

      // Check cancellation
      if (this.cancelledTasks.has(taskId)) {
        eventBus.publish({
          kind: 'status-update',
          taskId,
          contextId,
          status: { state: 'canceled', timestamp: new Date().toISOString() },
          final: true,
        } as TaskStatusUpdateEvent);
        eventBus.finished();
        this.cancelledTasks.delete(taskId);
        return;
      }

      // Artifact
      eventBus.publish({
        kind: 'artifact-update',
        taskId,
        contextId,
        artifact: {
          artifactId: `${taskId}-result`,
          name: 'response',
          parts: [{ kind: 'text', text: result }],
        },
      } as TaskArtifactUpdateEvent);

      // Status: COMPLETED
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: { state: 'completed', timestamp: new Date().toISOString() },
        final: true,
      } as TaskStatusUpdateEvent);

      // Record in channel
      const ch = chatChannels.get(contextId || taskId) || { contextId: contextId || taskId, remoteAgentUrl: REMOTE_AGENT_URL, history: [] };
      ch.history.push({ role: 'user', text: userText, timestamp: new Date().toISOString() });
      ch.history.push({ role: 'agent', text: result, timestamp: new Date().toISOString() });
      chatChannels.set(contextId || taskId, ch);

      console.log(`[A2A] Task ${taskId}: completed`);

    } catch (err: any) {
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'failed',
          message: {
            kind: 'message',
            role: 'agent',
            messageId: uuidv4(),
            parts: [{ kind: 'text', text: `執行失敗: ${err.message}` }],
            taskId,
            contextId,
          },
          timestamp: new Date().toISOString(),
        },
        final: true,
      } as TaskStatusUpdateEvent);
      console.error(`[A2A] Task ${taskId}: failed — ${err.message}`);
    }

    eventBus.finished();
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.cancelledTasks.add(taskId);
  }
}

// ════════════════════════════════════════════════════════
// 5. Webhook — 接收遠端 Agent Push Notification
// ════════════════════════════════════════════════════════

const pushNotificationStore = new InMemoryPushNotificationStore();
const pushNotificationSender = new DefaultPushNotificationSender(pushNotificationStore, {
  timeout: 5000,
  tokenHeaderName: 'X-A2A-Notification-Token',
});

// ════════════════════════════════════════════════════════
// 6. Express Server
// ════════════════════════════════════════════════════════

const agentExecutor = new RealAgentExecutor();
const taskStore = new InMemoryTaskStore();

const requestHandler = new DefaultRequestHandler(
  AGENT_CARD,
  taskStore,
  agentExecutor,
  undefined,
  pushNotificationStore,
  pushNotificationSender,
);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── CORS ──
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (_req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  next();
});

// ── A2A Protocol endpoints ──
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use('/a2a/jsonrpc', express.json(), jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
app.use('/a2a/rest', restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

// ── Webhook endpoint — 接收 push notification ──
app.post('/a2a/webhook', express.json(), (req, res) => {
  console.log('[A2A Webhook] Received push notification:', JSON.stringify(req.body).slice(0, 500));
  // Store for UI to display
  webhookEvents.push({ ...req.body, receivedAt: new Date().toISOString() });
  res.json({ ok: true });
});

// In-memory webhook events for UI
const webhookEvents: any[] = [];

// ── Custom API endpoints for UI ──
app.get('/api/channels', (_req, res) => {
  const channels = Array.from(chatChannels.values()).map(ch => ({
    contextId: ch.contextId,
    remoteAgentUrl: ch.remoteAgentUrl,
    messageCount: ch.history.length,
    lastActivity: ch.history[ch.history.length - 1]?.timestamp || null,
  }));
  res.json({ ok: true, data: channels });
});

app.get('/api/channels/:contextId', (req, res) => {
  const channel = chatChannels.get(req.params.contextId);
  if (!channel) return res.status(404).json({ ok: false, error: 'Channel not found' });
  res.json({ ok: true, data: channel });
});

app.get('/api/webhooks', (_req, res) => {
  res.json({ ok: true, data: webhookEvents.slice(-20) });
});

// ── Health ──
app.get('/health', (_req, res) => {
  const config = getLLMConfig();
  res.json({
    status: 'ok',
    agent: AGENT_CARD.name,
    version: AGENT_CARD.version,
    llm: config ? `${config.providerId || 'custom'}/${config.model}` : 'NOT CONFIGURED',
    remoteAgent: REMOTE_AGENT_URL,
    channels: chatChannels.size,
  });
});

// ── Serve UI ──
const _publicDir = _resolve(_thisDir, '../public');
app.use(express.static(_publicDir));
app.get('/', (_req, res) => {
  res.sendFile(_resolve(_publicDir, 'index.html'));
});

// Start
app.listen(PORT, () => {
  console.log(`\n🚀 Agent Orchestrator 已啟動`);
  console.log(`   UI         : http://localhost:${PORT}`);
  console.log(`   Agent Card : http://localhost:${PORT}/${AGENT_CARD_PATH}`);
  console.log(`   JSON-RPC   : http://localhost:${PORT}/a2a/jsonrpc`);
  console.log(`   Webhook    : http://localhost:${PORT}/a2a/webhook`);
  console.log(`   Health     : http://localhost:${PORT}/health`);

  const config = getLLMConfig();
  if (config) {
    console.log(`   LLM        : ${config.providerId || 'custom'}/${config.model}`);
  } else {
    console.log(`   ⚠️  LLM     : NOT CONFIGURED (set .env or ensure providers.json exists)`);
  }
  console.log(`   Remote     : ${REMOTE_AGENT_URL}`);

  // Discover remote agent skills on startup
  discoverRemoteAgent();
});
