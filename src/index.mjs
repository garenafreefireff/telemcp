import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = '2025-11-25';
const SERVER_INFO = { name: 'telegram-send-mcp', version: '1.1.0' };
const MEDIA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'media');
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

const tools = [
  {
    name: 'send_telegram_message',
    description: 'Send a text message to a Telegram chat using the configured bot.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Text to send. Telegram accepts 1–4096 characters.'
        },
        chat_id: {
          type: ['string', 'integer'],
          description: 'Telegram chat ID or @channel username. Defaults to TELEGRAM_CHAT_ID.'
        },
        disable_notification: {
          type: 'boolean',
          description: 'Send silently without a notification sound.'
        }
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: 'send_telegram_media',
    description: 'Send a photo, video, document, audio, voice note, animation, sticker, or video note to Telegram. Use a public HTTP(S) URL or a file inside the local media folder.',
    inputSchema: {
      type: 'object',
      properties: {
        media_type: {
          type: 'string',
          enum: ['photo', 'video', 'document', 'audio', 'voice', 'animation', 'sticker', 'video_note'],
          description: 'Telegram media type. Use document for other file formats.'
        },
        file_url: {
          type: 'string',
          format: 'uri',
          description: 'Public HTTP(S) URL readable by Telegram. Use exactly one of file_url or file_path.'
        },
        file_path: {
          type: 'string',
          description: 'File name or relative path inside D:\\telemcp\\media, such as photo.png. Use exactly one of file_url or file_path.'
        },
        caption: {
          type: 'string',
          description: 'Optional caption for the media (up to 1024 characters).'
        },
        chat_id: {
          type: ['string', 'integer'],
          description: 'Telegram chat ID. Defaults to TELEGRAM_CHAT_ID.'
        },
        disable_notification: {
          type: 'boolean',
          description: 'Send silently without a notification sound.'
        }
      },
      required: ['media_type'],
      additionalProperties: false
    }
  }
];

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function sendTelegramMessage(args = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN in the MCP server environment.');

  const chatId = args.chat_id ?? process.env.TELEGRAM_CHAT_ID;
  if (chatId === undefined || chatId === '') {
    throw new Error('Provide chat_id or set TELEGRAM_CHAT_ID in the MCP server environment.');
  }

  if (typeof args.message !== 'string' || args.message.trim().length === 0) {
    throw new Error('message must be a non-empty string.');
  }
  if ([...args.message].length > 4096) {
    throw new Error('message is longer than Telegram’s 4096-character limit.');
  }
  if (args.disable_notification !== undefined && typeof args.disable_notification !== 'boolean') {
    throw new Error('disable_notification must be a boolean.');
  }

  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: args.message,
        ...(args.disable_notification === undefined
          ? {}
          : { disable_notification: args.disable_notification })
      }),
      signal: AbortSignal.timeout(20_000)
    });
  } catch {
    throw new Error('Could not reach the Telegram Bot API. Check the network connection and try again.');
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram returned an unreadable response (HTTP ${response.status}).`);
  }

  if (!response.ok || result.ok !== true) {
    const description = typeof result.description === 'string'
      ? result.description
      : `HTTP ${response.status}`;
    throw new Error(`Telegram rejected the message: ${description}`);
  }

  const sent = result.result;
  return {
    content: [{
      type: 'text',
      text: `Message sent to chat ${sent.chat.id} (message ID ${sent.message_id}).`
    }],
    structuredContent: {
      chat_id: sent.chat.id,
      message_id: sent.message_id,
      date: sent.date
    }
  };
}

function getTelegramToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN in the MCP server environment.');
  return token;
}

function getTelegramChatId(args) {
  const chatId = args.chat_id ?? process.env.TELEGRAM_CHAT_ID;
  if (chatId === undefined || chatId === '') {
    throw new Error('Provide chat_id or set TELEGRAM_CHAT_ID in the MCP server environment.');
  }
  return chatId;
}

async function resolveMediaFile(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new Error('file_path must be a relative path inside the media folder.');
  }

  await mkdir(MEDIA_DIR, { recursive: true });
  const mediaRoot = await realpath(MEDIA_DIR);
  const requestedPath = await realpath(path.resolve(mediaRoot, relativePath));
  const relativeToRoot = path.relative(mediaRoot, requestedPath);
  if (!relativeToRoot || relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw new Error('file_path must point to a file inside the media folder.');
  }

  const info = await stat(requestedPath);
  if (!info.isFile()) throw new Error('file_path must point to a regular file.');
  if (info.size > MAX_MEDIA_BYTES) throw new Error('Media files must be 50 MB or smaller.');
  return requestedPath;
}

async function callTelegramApi(method, payload, filePath, fileField) {
  const token = getTelegramToken();
  let response;
  try {
    let options;
    if (filePath) {
      const bytes = await readFile(filePath);
      const form = new FormData();
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && value !== null) form.append(key, String(value));
      }
      form.append(fileField, new Blob([bytes]), path.basename(filePath));
      options = { method: 'POST', body: form };
    } else {
      options = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      };
    }

    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      ...options,
      signal: AbortSignal.timeout(60_000)
    });
  } catch {
    throw new Error('Could not reach the Telegram Bot API or read the selected media file. Check the network and file path.');
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok || result.ok !== true) {
    const description = typeof result.description === 'string' ? result.description : `HTTP ${response.status}`;
    throw new Error(`Telegram rejected the media: ${description}`);
  }
  return result.result;
}

async function sendTelegramMedia(args = {}) {
  const methods = {
    photo: ['sendPhoto', 'photo'],
    video: ['sendVideo', 'video'],
    document: ['sendDocument', 'document'],
    audio: ['sendAudio', 'audio'],
    voice: ['sendVoice', 'voice'],
    animation: ['sendAnimation', 'animation'],
    sticker: ['sendSticker', 'sticker'],
    video_note: ['sendVideoNote', 'video_note']
  };
  const methodInfo = methods[args.media_type];
  if (!methodInfo) throw new Error('Choose photo, video, document, audio, voice, animation, sticker, or video_note.');

  const hasUrl = typeof args.file_url === 'string' && args.file_url.trim() !== '';
  const hasPath = typeof args.file_path === 'string' && args.file_path.trim() !== '';
  if (hasUrl === hasPath) throw new Error('Provide exactly one of file_url or file_path.');
  if (args.caption !== undefined && (typeof args.caption !== 'string' || [...args.caption].length > 1024)) {
    throw new Error('caption must be a string of up to 1024 characters.');
  }
  if (['sticker', 'video_note'].includes(args.media_type) && args.caption) {
    throw new Error(`${args.media_type} does not support a caption.`);
  }
  if (args.disable_notification !== undefined && typeof args.disable_notification !== 'boolean') {
    throw new Error('disable_notification must be a boolean.');
  }

  const [method, fileField] = methodInfo;
  let filePath;
  let fileUrl;
  if (hasPath) {
    filePath = await resolveMediaFile(args.file_path);
  } else {
    let parsedUrl;
    try {
      parsedUrl = new URL(args.file_url);
    } catch {
      throw new Error('file_url must be a valid public HTTP(S) URL.');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      throw new Error('file_url must be a public HTTP(S) URL without embedded credentials.');
    }
    if (['sticker', 'video_note'].includes(args.media_type)) {
      throw new Error(`${args.media_type} must be sent from file_path in the media folder.`);
    }
    fileUrl = args.file_url;
  }

  const payload = {
    chat_id: getTelegramChatId(args),
    [fileField]: fileUrl,
    ...(args.caption ? { caption: args.caption } : {}),
    ...(args.disable_notification === undefined ? {} : { disable_notification: args.disable_notification })
  };
  const sent = await callTelegramApi(method, payload, filePath, fileField);
  return {
    content: [{ type: 'text', text: `${args.media_type} sent to chat ${sent.chat.id} (message ID ${sent.message_id}).` }],
    structuredContent: { chat_id: sent.chat.id, message_id: sent.message_id, date: sent.date, media_type: args.media_type }
  };
}

async function executeTool(name, args) {
  if (name === 'send_telegram_message') return sendTelegramMessage(args);
  if (name === 'send_telegram_media') return sendTelegramMedia(args);
  throw new Error(`Unknown tool: ${String(name)}`);
}

async function handleRequest(request) {
  const id = request?.id;
  const isNotification = id === undefined;

  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    if (!isNotification) write(jsonRpcError(id, -32600, 'Invalid JSON-RPC request.'));
    return;
  }

  if (isNotification && !request.method.startsWith('notifications/')) return;

  switch (request.method) {
    case 'initialize': {
      const requestedVersion = request.params?.protocolVersion;
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18', PROTOCOL_VERSION];
      const protocolVersion = supported.includes(requestedVersion)
        ? requestedVersion
        : PROTOCOL_VERSION;
      write(jsonRpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      }));
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      write(jsonRpcResult(id, {}));
      return;
    case 'tools/list':
      write(jsonRpcResult(id, { tools }));
      return;
    case 'tools/call': {
      const { name, arguments: args } = request.params ?? {};
      if (!tools.some((tool) => tool.name === name)) {
        write(jsonRpcError(id, -32602, `Unknown tool: ${String(name)}`));
        return;
      }
      try {
        write(jsonRpcResult(id, await executeTool(name, args)));
      } catch (error) {
        write(jsonRpcResult(id, {
          content: [{ type: 'text', text: error.message }],
          isError: true
        }));
      }
      return;
    }
    default:
      if (!isNotification) write(jsonRpcError(id, -32601, `Method not found: ${request.method}`));
  }
}

function httpResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function httpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function processHttpRequest(request) {
  const id = request?.id;
  const notification = id === undefined;
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return httpError(id ?? null, -32600, 'Invalid JSON-RPC request.');
  }

  if (notification) return null;

  switch (request.method) {
    case 'initialize': {
      const requestedVersion = request.params?.protocolVersion;
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18', PROTOCOL_VERSION];
      return httpResult(id, {
        protocolVersion: supported.includes(requestedVersion) ? requestedVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
    }
    case 'ping':
      return httpResult(id, {});
    case 'tools/list':
      return httpResult(id, { tools });
    case 'tools/call': {
      const { name, arguments: args } = request.params ?? {};
      if (!tools.some((tool) => tool.name === name)) {
        return httpError(id, -32602, `Unknown tool: ${String(name)}`);
      }
      try {
        return httpResult(id, await executeTool(name, args));
      } catch (error) {
        return httpResult(id, {
          content: [{ type: 'text', text: error.message }],
          isError: true
        });
      }
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    default:
      return httpError(id, -32601, `Method not found: ${request.method}`);
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function startHttpServer() {
  const port = Number(process.env.PORT || process.env.MCP_PORT || 3000);
  const defaultHost = process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1';
  const host = process.env.MCP_HOST || defaultHost;
  const server = createServer(async (request, response) => {
    if (request.url === '/' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Telegram MCP is running. Connect your MCP client at /mcp.');
      return;
    }

    if (request.url !== '/mcp') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found.');
      return;
    }

    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
      response.end('Use POST for MCP requests.');
      return;
    }

    let rpcRequest;
    try {
      rpcRequest = await readJsonBody(request);
    } catch (error) {
      const badJson = error instanceof SyntaxError;
      response.writeHead(badJson ? 400 : 413, { 'content-type': 'application/json' });
      response.end(JSON.stringify(httpError(null, badJson ? -32700 : -32600, badJson ? 'Parse error.' : error.message)));
      return;
    }

    try {
      const rpcResponse = await processHttpRequest(rpcRequest);
      if (rpcResponse === null) {
        response.writeHead(202);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(rpcResponse));
    } catch {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify(httpError(rpcRequest?.id ?? null, -32603, 'Internal server error.')));
    }
  });

  server.listen(port, host, () => {
    console.error(`Telegram MCP HTTP listening at http://${host}:${port}/mcp`);
  });
}

if (process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http') {
  startHttpServer();
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      write(jsonRpcError(null, -32700, 'Parse error.'));
      continue;
    }
    await handleRequest(request);
  }
}
