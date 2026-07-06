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
import { AgentCard, AGENT_CARD_PATH, Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent, MessageSendParams } from '@a2a-js/sdk';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { ClientFactory } from '@a2a-js/sdk/client';
import {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
  DefaultRequestHandler,
  InMemoryTaskStore,
  InMemoryPushNotificationStore,
  DefaultPushNotificationSender,
} from '@a2a-js/sdk/server';
import { JsonFileTaskStore } from './json-file-task-store.js';
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
  // 優先讀自己的 data/config/providers.json，不再依賴 tPAAW 絕對路徑
  const candidates = [
    _resolve(process.cwd(), 'data/config/providers.json'),
    _resolve(_thisDir, '../data/config/providers.json'),
    _resolve(_thisDir, '../../data/config/providers.json'),
    _resolve(_thisDir, '../../../data/config/providers.json'),
  ];
  console.log('[provider-config] searching candidates:', candidates);
  const configPath = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (configPath) {
    providerConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    console.log('[provider-config] loaded:', configPath);
  } else {
    console.warn('[provider-config] NO providers.json found in any candidate path');
  }
} catch (e) {
  console.error('[provider-config] Error loading providers.json:', e);
}


function getLLMModel() {
  const config = (() => {
    if (LLM_BASE_URL && LLM_API_KEY) {
      return { baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY, model: LLM_MODEL, providerId: 'custom' };
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
  })();

  if (!config) return null;

  const openai = createOpenAI({
    baseURL: config.baseURL.replace(/\/+$/, ''),
    apiKey: config.apiKey,
    headers: config.providerId === 'openrouter'
      ? { 'HTTP-Referer': 'https://agent-orchestrator.ai', 'X-Title': 'Agent Orchestrator' }
      : undefined,
  });

  return { model: openai(config.model), providerId: config.providerId, modelName: config.model };
}

// Legacy accessor for health/log display
function getLLMConfig() {
  const m = getLLMModel();
  if (!m) return null;
  return { providerId: m.providerId, model: m.modelName };
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
  const llm = getLLMModel();
  if (!llm) throw new Error('No LLM provider configured. Set .env or ensure providers.json exists.');

  // Vercel AI SDK: system message must be passed via `system` option, not in messages array
  let systemPrompt: string | undefined;
  const nonSystemMessages = messages.filter(m => {
    if (m.role === 'system') {
      systemPrompt = m.content;
      return false;
    }
    return true;
  });

  const { text } = await generateText({
    model: llm.model,
    system: systemPrompt,
    messages: nonSystemMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    temperature: 0.7,
    maxOutputTokens: 2000,
  });

  return text || '(empty response)';
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

// ── A2A SDK Client (for talking to PAAW via protocol) ──
let paawClient: Awaited<ReturnType<ClientFactory['createFromUrl']>> | null = null;
const clientFactory = new ClientFactory();

// Helper for trace formatting
function truncateMsg(msg: string, max = 500): string {
  return msg.length > max ? msg.slice(0, max) + '...' : msg;
}

// ── Remote call mode: 'async' (webhook+poll) or 'sync' (blocking) ──
let remoteCallMode: 'async' | 'sync' = 'async';

async function getPaawClient() {
  if (!paawClient) {
    paawClient = await clientFactory.createFromUrl(REMOTE_AGENT_URL);
    console.log(`[A2A Client] SDK client connected to ${REMOTE_AGENT_URL}`);
  }
  return paawClient;
}

/**
 * Send message to PAAW via A2A SDK client.
 * Uses webhook + polling: sends with pushNotification config, PAAW returns 'working'
 * immediately, then we poll tasks/get until completed/input-required/failed.
 * Falls back to sync mode if PAAW doesn't support webhooks.
 */
async function sendViaA2ASDK(text: string, contextId?: string, onStatus?: (s: string) => void, taskId?: string): Promise<{ task: any; contextId: string }> {
  const client = await getPaawClient();
  const cid = contextId || `ctx-${Date.now()}`;

  // ── Build send params based on remoteCallMode ──
  const asyncMode = remoteCallMode === 'async';
  const sendParams: MessageSendParams = {
    message: {
      kind: 'message',
      role: 'user',
      messageId: `msg-${uuidv4()}`,
      parts: [{ kind: 'text', text }],
      ...(cid ? { contextId: cid } : {}),
    },
    ...(asyncMode ? {
      configuration: {
        pushNotification: {
          url: `http://localhost:${PORT}/a2a/webhook`,
          token: 'orch-webhook',
        },
        blocking: false,
      },
    } : {}),
  } as any;

  console.log(`[A2A-SDK] mode=${remoteCallMode} sending: "${text.slice(0, 60)}"`);

  const response = await client.sendMessage(sendParams);
  const task = response as any;
  const taskState = task?.status?.state;

  console.log(`[A2A-SDK] Initial response: state=${taskState} taskId=${task?.id}`);
  if (onStatus) onStatus(taskState);

  // Persist: A2A response event (after SDK has saved the task)
  if (taskId) {
    setTimeout(() => {
      taskStore.appendEvent(taskId, { type: 'a2a_send', name: 'message/send', text: text.slice(0, 200) }).catch(() => {});
      taskStore.appendEvent(taskId, { type: 'a2a_response', name: `task:${taskState}`, remoteTaskId: task?.id }).catch(() => {});
    }, 500);
  }

  // ── ASYNC: If working, poll tasks/get until terminal state ──
  if (asyncMode && taskState === 'working' && task?.id) {
    const pollTaskId = task.id;
    const MAX_POLLS = 90; // 90 × 2s = 180s timeout

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, 2000));

      let polled: any;
      try {
        polled = await client.getTask({ id: pollTaskId });
      } catch {
        try {
          const pr = await fetch(`${REMOTE_AGENT_URL}/a2a`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'tasks/get', params: { id: pollTaskId }, id: `poll-${i}` }),
          });
          const pd = await pr.json() as any;
          polled = pd.result;
        } catch (e: any) {
          console.log(`[A2A-SDK] Poll ${i + 1} error: ${e.message}`);
          continue;
        }
      }

      const pollState = polled?.status?.state;
      if (onStatus) onStatus(pollState);
      console.log(`[A2A-SDK] Poll ${i + 1}/${MAX_POLLS}: state=${pollState}`);

      if (['completed', 'failed', 'canceled', 'input-required'].includes(pollState)) {
        const channel = chatChannels.get(cid) || { contextId: cid, remoteAgentUrl: REMOTE_AGENT_URL, history: [] };
        channel.history.push({ role: 'user', text, timestamp: new Date().toISOString() });

        let responseText = '';
        if (polled?.artifacts?.[0]?.parts?.[0]?.text) {
          responseText = polled.artifacts[0].parts[0].text;
        } else if (polled?.history) {
          const lastAgent = [...polled.history].reverse().find((m: any) => m.role === 'agent');
          if (lastAgent?.parts?.[0]?.text) responseText = lastAgent.parts[0].text;
        }
        channel.history.push({ role: 'remote', text: responseText, timestamp: new Date().toISOString() });
        chatChannels.set(cid, channel);

        return { task: polled, contextId: cid };
      }
    }

    throw new Error(`Timeout: PAAW task ${pollTaskId} did not complete within 180s`);
  }

  // ── SYNC (or async but immediate terminal state): use response directly ──
  const channel = chatChannels.get(cid) || { contextId: cid, remoteAgentUrl: REMOTE_AGENT_URL, history: [] };
  channel.history.push({ role: 'user', text, timestamp: new Date().toISOString() });

  let responseText = '';
  if (task?.artifacts?.[0]?.parts?.[0]?.text) {
    responseText = task.artifacts[0].parts[0].text;
  } else if (task?.history) {
    const lastAgent = [...task.history].reverse().find((m: any) => m.role === 'agent');
    if (lastAgent?.parts?.[0]?.text) responseText = lastAgent.parts[0].text;
  }
  channel.history.push({ role: 'remote', text: responseText, timestamp: new Date().toISOString() });
  chatChannels.set(cid, channel);

  return { task, contextId: cid };
}

/**
 * Legacy: Send message to remote agent (fallback, used for non-SDK paths)
 */
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
// 4. Task Persistence (JSON file-based) — declared early for AgentExecutor
// ════════════════════════════════════════════════════════

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TASKS_DIR = resolve(__dirname, '../data/a2a-tasks');
const taskStore = new JsonFileTaskStore(TASKS_DIR);

// ════════════════════════════════════════════════════════
// 5. Agent Executor — 真的 Agent Loop
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

    // ── Phase 1: Load task context from persistence ──
    let memoryContext = '';
    try {
      const existingTask = await taskStore.load(taskId) as any;
      if (existingTask?.memory?.length) {
        memoryContext = '\n\n## Previous Memory\n' + existingTask.memory
          .map((m: any) => `- [${m.type}] ${m.content}`)
          .join('\n');
      }
      if (existingTask?.events?.length) {
        const recentEvents = existingTask.events.slice(-10);
        memoryContext += '\n\n## Recent Events\n' + recentEvents
          .map((e: any) => `- ${e.type}: ${e.name || JSON.stringify(e).slice(0, 80)}`)
          .join('\n');
      }
    } catch { /* task not yet saved */ }

    // Persist: task started
    // (events will be flushed after SDK saves the task, to avoid overwrite)
    const _pendingEvents: any[] = [{ type: 'task_start', name: 'agent_loop', text: userText.slice(0, 200) }];

    try {
      // Build messages for LLM
      const channel = chatChannels.get(contextId || '');
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: buildSystemPrompt() + memoryContext },
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
      const hdTrace: Array<{ round: number; question: string; response: string; status: string; clarify?: string }> = [];

      // Persist: LLM decision
      _pendingEvents.push({ type: 'llm_decision', name: remoteMatch ? 'remote_call' : 'local_answer' });

      if (remoteMatch) {
        const remoteQuestion = remoteMatch[1].trim();
        console.log(`[A2A] LLM requests remote: "${remoteQuestion.slice(0, 80)}"`);

        // Check if this maps to a specific skill endpoint (e.g. helpdesk)
        const helpdeskSkill = remoteSkills.find(s => s.id === 'paaw-helpdesk' || s.tags.includes('helpdesk'));
        let remoteResponse = '';

        if (helpdeskSkill) {
          // ── Multi-turn A2A via SDK Client ──
          // Use SDK sendMessage to talk to PAAW's A2A endpoint.
          // PAAW may return task with status 'input-required'.
          // Orchestrator LLM auto-answers clarification, loops up to MAX_ROUNDS.
          const MAX_ROUNDS = 3;
          let hdMessage = remoteQuestion;
          let hdRound = 0;
          let a2aContextId = contextId || `hd-ctx-${Date.now()}`;

          console.log(`[A2A] SDK multi-turn start: "${remoteQuestion.slice(0, 60)}" context=${a2aContextId}`);

          for (let round = 0; round < MAX_ROUNDS; round++) {
            hdRound++;

            // ── Use SDK Client to send message ──
            const sdkResult = await sendViaA2ASDK(hdMessage, a2aContextId, undefined, taskId);
            const hdTask = sdkResult.task;
            a2aContextId = sdkResult.contextId;

            const taskState = hdTask?.status?.state;
            console.log(`[A2A] SDK round ${hdRound} state=${taskState}`);

            // Extract text from task
            let taskText = '';
            if (hdTask?.artifacts?.[0]?.parts?.[0]?.text) {
              taskText = hdTask.artifacts[0].parts[0].text;
            } else if (hdTask?.history) {
              const lastAgent = [...hdTask.history].reverse().find((m: any) => m.role === 'agent');
              if (lastAgent?.parts?.[0]?.text) taskText = lastAgent.parts[0].text;
            }

            if (taskState === 'input-required' && taskText) {
              // HelpDesk wants clarification — LLM auto-generates answer
              console.log(`[A2A] SDK round ${hdRound} needs info: "${taskText.slice(0, 80)}"`);

              const clarifyRes = await callLLM([
                { role: 'system', content: '你是 Agent Orchestrator。你正在跟 PAAW HelpDesk 的 AI 互動。' },
                { role: 'user', content: `原始使用者問題：「${userText}」\n你問了 HelpDesk：「${remoteQuestion}」\nHelpDesk 反問：「${taskText}」\n\n請根據使用者的原始問題，直接回答 HelpDesk 的問題。只輸出答案，不要加解釋。如果使用者的問題裡沒有足夠資訊，就回答「沒有特別指定」。` },
              ]);

              hdMessage = clarifyRes.trim();
              console.log(`[A2A] SDK round ${hdRound} auto-clarify: "${hdMessage.slice(0, 80)}"`);

              hdTrace.push({ round: hdRound, question: truncateMsg(hdMessage), response: truncateMsg(taskText), status: 'input-required', clarify: truncateMsg(hdMessage) });

              continue;
            }

            if (taskState === 'completed' && taskText) {
              // Got final answer
              remoteResponse = taskText;
              console.log(`[A2A] SDK answered (round ${hdRound}, ${taskText.length} chars)`);
              hdTrace.push({ round: hdRound, question: truncateMsg(hdMessage), response: truncateMsg(taskText), status: 'answered' });
              break;
            }

            // Unknown state — try to use whatever text we got
            if (taskText) {
              remoteResponse = taskText;
              hdTrace.push({ round: hdRound, question: truncateMsg(hdMessage), response: truncateMsg(taskText), status: taskState || 'unknown' });
              break;
            }

            remoteResponse = `HelpDesk 回傳了未預期的狀態: ${taskState}`;
            hdTrace.push({ round: hdRound, question: truncateMsg(hdMessage), response: truncateMsg(remoteResponse), status: 'error' });
            break;
          }

          if (hdRound >= MAX_ROUNDS && !remoteResponse) {
            remoteResponse = `HelpDesk 在 ${MAX_ROUNDS} 輪 A2A 互動後仍無法產出完整答案。`;
          }

          result = remoteResponse;
        } else {
          // General A2A message/send
          const remoteResult = await sendToRemoteAgent(remoteQuestion, contextId);
          remoteResponse = remoteResult.response;

          // LLM synthesizes final answer for non-helpdesk
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
      const artifactParts: any[] = [{ kind: 'text', text: result }];

      // If multi-turn HelpDesk interaction happened, add trace as metadata part
      if (hdTrace.length > 0) {
        artifactParts.push({
          kind: 'text',
          text: JSON.stringify({ type: 'hd-trace', ticketId: hdTrace[0] ? (hdTrace as any)._ticketId : null, rounds: hdTrace }),
          metadata: { role: 'hd-trace' },
        } as any);
      }

      eventBus.publish({
        kind: 'artifact-update',
        taskId,
        contextId,
        artifact: {
          artifactId: `${taskId}-result`,
          name: 'response',
          parts: artifactParts,
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

      // ── Phase 1: Flush all pending events after SDK has saved the task ──
      _pendingEvents.push({ type: 'task_complete', name: 'agent_loop', rounds: hdTrace.length });
      // Give SDK a tick to finish its save, then flush events
      await new Promise(r => setTimeout(r, 50));
      for (const ev of _pendingEvents) {
        await taskStore.appendEvent(taskId, ev);
      }

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
      await taskStore.appendEvent(taskId, { type: 'task_failed', name: 'agent_loop', error: err.message.slice(0, 200) });
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

// taskStore already declared above (before AgentExecutor)

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
// Also broadcasts to SSE clients so the UI updates in real-time
const sseClients: Array<{ res: any }> = [];

app.post('/a2a/webhook', express.json(), (req, res) => {
  const payload = req.body;
  console.log('[A2A Webhook] Received push notification:', JSON.stringify(payload).slice(0, 500));
  // Store for UI to display
  webhookEvents.push({ ...payload, receivedAt: new Date().toISOString() });
  // Broadcast to SSE clients
  for (const client of sseClients) {
    try {
      client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {}
  }
  res.json({ ok: true });
});

// ── SSE endpoint — frontend subscribes to get webhook results in real-time ──
app.get('/api/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  const client = { res };
  sseClients.push(client);
  req.on('close', () => {
    const idx = sseClients.indexOf(client);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// In-memory webhook events for UI
const webhookEvents: any[] = [];

// ── Custom API endpoints for UI ──
app.get('/api/models', (_req, res) => {
  if (!providerConfig) return res.json({ models: [], defaultModel: '', active: '' });
  const active = providerConfig.active || '';
  const provider = providerConfig.providers?.[active];
  const models: any[] = [];
  for (const [pid, p] of Object.entries<any>(providerConfig.providers || {})) {
    for (const m of (p.models || [])) {
      models.push({ id: m.id, name: m.name, provider: pid, providerName: p.name });
    }
  }
  res.json({ active, defaultModel: providerConfig.defaultModel || '', models });
});

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

// ── Remote call mode (sync vs async/webhook) ──
app.get('/api/mode', (_req, res) => {
  res.json({ ok: true, mode: remoteCallMode });
});
app.post('/api/mode', express.json(), (req, res) => {
  const m = req.body.mode;
  if (m === 'async' || m === 'sync') {
    remoteCallMode = m;
    console.log(`[Mode] Switched to ${remoteCallMode}`);
    res.json({ ok: true, mode: remoteCallMode });
  } else {
    res.status(400).json({ ok: false, error: 'mode must be async or sync' });
  }
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
const httpServer = app.listen(PORT, () => {
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

// ── Graceful shutdown for tsx watch ──
// tsx watch sends SIGTERM on file change, expects process to exit within 5s
// For a dev server, immediate exit is fine — tsx watch restarts it instantly
process.on('SIGTERM', () => { console.log('[SIGTERM] Exiting...'); process.exit(0); });
process.on('SIGINT', () => { console.log('[SIGINT] Exiting...'); process.exit(0); });
