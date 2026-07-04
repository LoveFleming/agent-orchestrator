/**
 * Agent Hub — Agent2Agent Protocol Agent
 *
 * 功能：
 *   1. A2A Server — 暴露 Agent Card + JSON-RPC
 *   2. Agent Loop — 接 LLM API，真的會思考和回答
 *   3. A2A Client — 可以主動呼叫遠端 Agent，建立聊天通道
 *   4. UI — 聊天介面 + 與遠端 Agent 的對話視窗
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

// Resolve paths relative to this file
import { fileURLToPath as _fileURLToPath } from 'url';
import { dirname as _dirname, resolve as _resolve } from 'path';
const _thisDir = _dirname(_fileURLToPath(import.meta.url));

// Try to load from sibling config (e.g. ../data/config/providers.json)
let providerConfig: any = null;
try {
  const fs = await import('fs');
  const candidates = [
    _resolve(_thisDir, '../../../tAgent/data/config/providers.json'),
    _resolve(_thisDir, '../../tAgent/data/config/providers.json'),
    _resolve(process.cwd(), '../tAgent/data/config/providers.json'),
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

const AGENT_HUB_CARD: AgentCard = {
  name: 'Agent Hub',
  description: 'Agent Hub — 獨立思考、回答問題，也可以透過 A2A 協議與遠端 Agent 協作',
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

const SYSTEM_PROMPT = `你是 Agent Hub，一個友善的 AI 助手。

你的特殊能力：你可以透過 A2A (Agent-to-Agent) 協議與遠端的 Agent 溝通。

當使用者要求你跟遠端 Agent 討論或協作時，你應該：
1. 用中文整理你要問遠端 Agent 的內容
2. 系統會幫你把訊息送到遠端 Agent
3. 收到回應後，用中文整理給使用者

你也能獨立回答問題，不一定每次都要找遠端 Agent。

回答風格：簡潔、友善、用中文。`;

async function callLLM(messages: Array<{ role: string; content: string }>): Promise<string> {
  const config = getLLMConfig();
  if (!config) throw new Error('No LLM provider configured. Set .env or ensure providers.json exists.');

  const baseURL = config.baseURL.replace(/\/+$/, '');
  const extraHeaders: Record<string, string> = {};
  if (config.providerId === 'openrouter') {
    extraHeaders['HTTP-Referer'] = 'https://agent-hub.ai';
    extraHeaders['X-Title'] = 'Agent Hub';
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
        { role: 'system', content: SYSTEM_PROMPT },
      ];

      // Add conversation history from channel if exists
      if (channel?.history.length) {
        for (const entry of channel.history.slice(-10)) {
          const prefix = entry.role === 'remote' ? '遠端 Agent 說：' : '使用者說：';
          messages.push({ role: 'user', content: `${prefix}${entry.text}` });
        }
      }

      messages.push({ role: 'user', content: userText });

      // Decide: should we call remote agent?
      const needRemote = /跟遠端|和遠端|問遠端|遠端 Agent|協作|合作|一起|討論/.test(userText);

      let result: string;

      if (needRemote) {
        // Step 1: LLM decides what to ask remote
        messages.push({ role: 'user', content: '你決定要跟遠端 Agent 討論。請用一句話說明你想問遠端 Agent 什麼？只輸出要問的話，不要加解釋。' });
        const remoteQuestion = await callLLM(messages);
        console.log(`[A2A] Asking remote: "${remoteQuestion.slice(0, 80)}"`);

        // Step 2: Send to remote agent
        const remoteResult = await sendToRemoteAgent(remoteQuestion, contextId);
        const remoteResponse = remoteResult.response;

        // Step 3: LLM synthesizes the answer
        const synthesisMessages = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `使用者問：「${userText}」` },
          { role: 'user', content: `我問了遠端 Agent：「${remoteQuestion}」` },
          { role: 'user', content: `遠端 Agent 回答：「${remoteResponse}」` },
          { role: 'user', content: '請根據以上資訊，用中文整理一個完整的回答給使用者。如果有引用遠端 Agent 的內容，請標註。' },
        ];
        result = await callLLM(synthesisMessages);
      } else {
        // Just use local LLM
        result = await callLLM(messages);
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
  AGENT_HUB_CARD,
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
    agent: AGENT_HUB_CARD.name,
    version: AGENT_HUB_CARD.version,
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
  console.log(`\n🚀 Agent Hub 已啟動`);
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
  console.log(`   Remote     : ${REMOTE_AGENT_URL}\n`);
});
