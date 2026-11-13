# Telegram Send MCP

A minimal MCP server that sends text messages through the Telegram Bot API. It uses Node.js 20+ and has no npm dependencies. The server supports stdio for local MCP clients and Streamable HTTP for ChatGPT web.

## 1. Create and configure a Telegram bot

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Open a chat with the bot and send `/start` so it can message you. For a group or channel, add the bot and make sure it has permission to post.
3. Copy `.env.example` to `.env` and fill in the bot token and chat ID. To look up your chat ID, send `/start` to your bot, set the token in PowerShell with `$env:TELEGRAM_BOT_TOKEN = "your-bot-token"`, then run:

   ```powershell
   (Invoke-RestMethod "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/getUpdates").result.message.chat
   ```

   For a group or channel, send a message there after adding the bot and inspect the matching update's `message.chat.id`.

## 2. Connect it to an MCP client

Configure the client to launch `node` with the absolute path to `src/index.mjs`. For Codex Desktop, add a server entry in its MCP configuration (typically `~/.codex/config.toml`):

```toml
[mcp_servers.telegram]
command = "node"
args = ["--env-file=D:/telemcp/.env", "D:/telemcp/src/index.mjs"]
```

The `.env` file is ignored by Git. Keep its token private. Restart or reload the MCP client after changing its configuration.

## 3. Connect to ChatGPT web with a temporary public URL

The HTTP endpoint is `http://127.0.0.1:3000/mcp`. To provide a temporary HTTPS URL for ChatGPT, open two PowerShell windows.

In the first window:

```powershell
cd D:\telemcp
node --env-file=.env src/index.mjs --http
```

In the second window:

```powershell
cloudflared tunnel --url http://localhost:3000
```

Cloudflare prints a temporary `https://...trycloudflare.com` URL. Add `/mcp` to its end (for example, `https://example.trycloudflare.com/mcp`). In ChatGPT web, open Plugins, choose **+ → Add custom MCP server**, paste the endpoint URL, choose **No authentication**, then create and install the plugin. Stop both processes with Ctrl+C when finished; the temporary URL stops working with the tunnel.

This endpoint has no authentication as requested. While the tunnel is running, anyone who has its URL can call the Telegram send tool.

## Tool

`send_telegram_message` accepts:

- `message` (required): text to send, up to 4096 characters.
- `chat_id` (optional): numeric chat ID or `@channel` username; defaults to `TELEGRAM_CHAT_ID`.
- `disable_notification` (optional): send without a notification sound.

The bot must have permission to send messages to the selected chat. The server sends only when the MCP client calls this tool.

## Media

`send_telegram_media` supports photos, videos, documents, audio, voice notes, animations, stickers, and video notes. It accepts either:

- `file_url`: a public HTTP(S) file URL that Telegram can fetch.
- `file_path`: a relative path inside `D:\telemcp\media`. For example, put `photo.jpg` there and pass `photo.jpg`.

The local path option is limited to the `media` folder and files up to 50 MB. ChatGPT web cannot directly read an attachment from the chat as a local file; save it into `D:\telemcp\media` first, or use an accessible public URL. Stickers and video notes use a local file path.
