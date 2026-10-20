const crypto = require("crypto");

// 批注 2026-10-20：Anthropic 原生 Messages API 的纯函数工具。
// 只读取/追加内容，不重排、不改写 Kelivo 发来的任何历史块（thinking 签名、cache_control 都原样保留）。
const DEFAULT_ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

function anthropicContentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // 只取 text 块；thinking / redacted_thinking / tool_use / tool_result 一律跳过，图片和文档只留占位。
  return content
    .map(block => {
      if (typeof block === "string") return block.trim();
      if (!block || typeof block !== "object") return "";
      if (block.type === "text") return String(block.text || "").trim();
      if (block.type === "image") return "[图片]";
      if (block.type === "document") return "[文件]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function anthropicSystemToText(system) {
  if (typeof system === "string") return system;
  return anthropicContentToText(system);
}

// 把原生请求体转换成时间线使用的 { role, content: string } 列表；纯工具往返（没有文字）的消息不进时间线。
function anthropicBodyToTimelineMessages(body) {
  const result = [];
  const systemText = anthropicSystemToText(body?.system).trim();
  if (systemText) result.push({ role: "system", content: systemText });
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const msg of messages) {
    if (msg?.role !== "user" && msg?.role !== "assistant") continue;
    const text = anthropicContentToText(msg.content).trim();
    if (!text) continue;
    result.push({ role: msg.role, content: text });
  }
  return result;
}

// 注入记录的 key：上一条消息 + 这条 user 消息的原始 JSON。上一条通常是带签名的 assistant 回复，
// 所以即使用户两次都只发“嗯”，key 也不会撞车。
function injectionKey(previousMessage, message) {
  const hash = crypto.createHash("sha256");
  hash.update(previousMessage ? JSON.stringify(previousMessage) : "");
  hash.update("\u0000");
  hash.update(JSON.stringify(message?.content ?? null));
  return hash.digest("hex");
}

function buildInjectionNote(events) {
  return [
    "[网关附注：以下是你在上一轮回复之后、用户这条消息之前的后台自主唤醒记录。由系统自动附加，不是用户写的。]",
    ...events
  ].join("\n");
}

function hasToolResult(content) {
  return Array.isArray(content) && content.some(block => block && block.type === "tool_result");
}

// 返回新的消息对象，不修改入参。没有 tool_result 时附注放在最前（按时间顺序：先发生的唤醒，后到的用户消息）；
// 有 tool_result 时 API 要求它们排在最前，附注就追加到末尾。
function applyInjection(message, note) {
  const noteBlock = { type: "text", text: note };
  const content = message.content;
  let nextContent;
  if (typeof content === "string") {
    nextContent = [noteBlock, { type: "text", text: content }];
  } else if (Array.isArray(content)) {
    nextContent = hasToolResult(content) ? [...content, noteBlock] : [noteBlock, ...content];
  } else {
    nextContent = [noteBlock];
  }
  return { ...message, content: nextContent };
}

function extractResponseText(data) {
  return anthropicContentToText(Array.isArray(data?.content) ? data.content : []).trim();
}

// 流式响应一边原样转发，一边从 content_block_delta 的 text_delta 里拼出回复正文，结束后再写时间线。
function createSseTextAccumulator() {
  const decoder = new TextDecoder();
  const blocks = new Map();
  let buffer = "";

  function handleLine(line) {
    const match = line.match(/^data:\s*(.*)$/);
    if (!match) return;
    let payload;
    try { payload = JSON.parse(match[1]); } catch { return; }
    if (payload?.type === "content_block_start" && payload.content_block?.type === "text") {
      blocks.set(payload.index, String(payload.content_block.text || ""));
    } else if (payload?.type === "content_block_delta" && payload.delta?.type === "text_delta") {
      blocks.set(payload.index, (blocks.get(payload.index) || "") + String(payload.delta.text || ""));
    }
  }

  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
      }
    },
    finish() {
      buffer += decoder.decode();
      if (buffer) handleLine(buffer.replace(/\r$/, ""));
      buffer = "";
      return [...blocks.keys()]
        .sort((a, b) => a - b)
        .map(index => blocks.get(index).trim())
        .filter(Boolean)
        .join("\n");
    }
  };
}

module.exports = {
  DEFAULT_ANTHROPIC_API_URL,
  DEFAULT_ANTHROPIC_VERSION,
  anthropicBodyToTimelineMessages,
  anthropicContentToText,
  anthropicSystemToText,
  applyInjection,
  buildInjectionNote,
  createSseTextAccumulator,
  extractResponseText,
  injectionKey
};
