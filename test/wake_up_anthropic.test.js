const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { formatDateTimeInTimeZone } = require("../time_utils");

// 批注 2026-10-20：WAKE_API_FORMAT=anthropic 时，wake_up.js 直连原生 Messages API；
// 用本地假服务同时扮演 Anthropic 上游、Gateway 内部接口和 ntfy，验证请求形状与原有推送逻辑。
const TIME_ZONE = "Europe/London";
const UPSTREAM_KEY = "sk-ant-wake-test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-wake-anthropic-"));

const fake = { requests: [], wakeEvents: [], ntfy: [], reply: null, server: null };

function setReply(status, payload) {
  fake.reply = { status, body: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

function anthropicText(text) {
  return {
    id: "msg_wake",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "sig-wake" },
      { type: "text", text }
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 80 }
  };
}

let wake;

test.before(async () => {
  fake.server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/v1/messages") {
        fake.requests.push({ headers: req.headers, body });
        res.writeHead(fake.reply.status, { "Content-Type": "application/json" });
        return res.end(fake.reply.body);
      }
      if (req.url === "/internal/wake-event") {
        const content = JSON.parse(body).content;
        fake.wakeEvents.push(content);
        // 和真实 Gateway 一样把事件追加到时间线末尾，后续唤醒才能看到“本次沉默期间的事件”。
        const timelineFile = path.join(dataDir, "enhanced_messages.json");
        const timeline = JSON.parse(fs.readFileSync(timelineFile, "utf8"));
        const maxPos = Math.max(...timeline.map(msg => msg.position || 0));
        timeline.push({ role: "assistant", content, position: maxPos + 0.5 });
        fs.writeFileSync(timelineFile, JSON.stringify(timeline));
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end('{"success":true}');
      }
      if (req.url === "/ntfy") {
        fake.ntfy.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end("{}");
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise(resolve => fake.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${fake.server.address().port}`;

  for (const key of ["TARGET_API_URL", "TARGET_API_KEY", "WAKE_PROMPT_TEMPLATE", "RAILWAY_VOLUME_MOUNT_PATH", "WAKE_CACHE_TTL", "WAKE_MAX_TOKENS"]) {
    delete process.env[key];
  }
  Object.assign(process.env, {
    WAKE_UP_NO_AUTOSTART: "1",
    WAKE_API_FORMAT: "anthropic",
    ANTHROPIC_API_URL: `${base}/v1/messages`,
    ANTHROPIC_API_KEY: UPSTREAM_KEY,
    MODEL_NAME: "claude-opus-5-5",
    DATA_DIR: dataDir,
    DIARY_DIR: path.join(dataDir, "diary"),
    DIARY_ENABLED: "true",
    GATEWAY_BASE_URL: base,
    PUSH_PROVIDER: "ntfy",
    NTFY_SERVER_URL: `${base}/ntfy`,
    NTFY_TOPIC: "wake-test",
    TIME_ZONE,
    WEATHER_ENABLED: "false",
    DAY_WAKE_AFTER_MINUTES: "1",
    NIGHT_WAKE_AFTER_MINUTES: "1"
  });

  const lastUserTime = formatDateTimeInTimeZone(new Date(Date.now() - 3 * 60 * 60 * 1000), TIME_ZONE);
  fs.writeFileSync(path.join(dataDir, "enhanced_messages.json"), JSON.stringify([
    { role: "system", content: "你是Dylan，说话温柔。\n## Memories\n不该发给唤醒的记忆", position: 0 },
    { role: "user", content: `${lastUserTime} 我去图书馆啦`, position: 1 },
    { role: "assistant", content: "去吧，回来接着聊。", position: 2 }
  ]));

  wake = require("../wake_up");
});

test.after(async () => {
  await new Promise(resolve => fake.server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("defaults to the OpenAI format when WAKE_API_FORMAT is unset", () => {
  const saved = process.env.WAKE_API_FORMAT;
  delete process.env.WAKE_API_FORMAT;
  try {
    assert.equal(wake.wakeApiFormat(), "openai");
  } finally {
    process.env.WAKE_API_FORMAT = saved;
  }
  assert.equal(wake.wakeApiFormat(), "anthropic");
});

test("sends a native Messages request and records [NO_ACTION] as a silent wake", async () => {
  setReply(200, anthropicText("[NO_ACTION] 她在学习"));
  await wake.runWakeUp();

  assert.equal(fake.requests.length, 1);
  const { headers, body } = fake.requests[0];
  assert.equal(headers["x-api-key"], UPSTREAM_KEY);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers.authorization, undefined);

  const request = JSON.parse(body);
  assert.equal(request.model, "claude-opus-5-5");
  assert.equal(typeof request.max_tokens, "number");
  assert.ok(request.max_tokens >= 1000);
  assert.equal("temperature" in request, false);
  assert.equal("top_p" in request, false);
  assert.equal("thinking" in request, false);
  assert.equal(request.stream, false);

  assert.ok(Array.isArray(request.system));
  assert.deepEqual(request.system[0].cache_control, { type: "ephemeral" });
  assert.match(request.system[0].text, /你是Dylan/);
  assert.ok(!request.system[0].text.includes("不该发给唤醒的记忆"));

  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, "user");
  const [historyBlock, variableBlock, ...rest] = request.messages[0].content;
  assert.equal(rest.length, 0);
  // 断点顺序：system 人设（缓存）→ 聊天记录（缓存）→ 每次都变的唤醒提示（最后、不缓存）。
  assert.deepEqual(historyBlock.cache_control, { type: "ephemeral" });
  assert.match(historyBlock.text, /我去图书馆啦/);
  assert.ok(!/距离用户最后一条消息|当前时间/.test(historyBlock.text), "no time-dependent text in the cached history");
  assert.equal(variableBlock.cache_control, undefined);
  assert.match(variableBlock.text, /当前时间/);
  assert.match(variableBlock.text, /距离用户最后一条消息：\d+ 分钟/);
  assert.match(variableBlock.text, /\[NO_ACTION\]/);
  assert.match(variableBlock.text, /\[DIARY\]/);

  assert.equal(fake.ntfy.length, 0);
  assert.equal(fake.wakeEvents.length, 1);
  assert.match(fake.wakeEvents[0], /自动唤醒：本次未发送推送｜原因：她在学习）$/);
});

test("pushes normal text and saves the diary block", async () => {
  setReply(200, anthropicText("想你了\n图书馆冷不冷？\n[DIARY]今天她去图书馆了。[/DIARY]"));
  await wake.runWakeUp();

  assert.equal(fake.ntfy.length, 1);
  assert.equal(fake.ntfy[0].title, "想你了");
  assert.equal(fake.ntfy[0].message, "图书馆冷不冷？");
  assert.match(fake.wakeEvents[fake.wakeEvents.length - 1], /刚刚给用户发了ntfy推送：想你了｜图书馆冷不冷？）$/);

  const diaryFiles = fs.readdirSync(path.join(dataDir, "diary"));
  assert.equal(diaryFiles.length, 1);
  assert.match(fs.readFileSync(path.join(dataDir, "diary", diaryFiles[0]), "utf8"), /今天她去图书馆了。/);
});

test("two wakes in one silence period share a byte-identical cached prefix", async t => {
  setReply(200, anthropicText("[NO_ACTION] 再等等"));
  const before = fake.requests.length;
  await wake.runWakeUp();

  // 五分钟后的下一次唤醒：时间、分钟数都变了，上一次唤醒也已经写进了时间线。
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 5 * 60 * 1000 });
  await wake.runWakeUp();
  t.mock.timers.reset();

  assert.equal(fake.requests.length, before + 2);
  const first = JSON.parse(fake.requests[before].body);
  const second = JSON.parse(fake.requests[before + 1].body);

  assert.equal(JSON.stringify(second.system), JSON.stringify(first.system));
  assert.equal(JSON.stringify(second.messages[0].content[0]), JSON.stringify(first.messages[0].content[0]));
  assert.notEqual(second.messages[0].content[1].text, first.messages[0].content[1].text);

  // 沉默期间的唤醒事件只出现在最后的变化块里，不会改动缓存的聊天记录块。
  const latestEvent = fake.wakeEvents[fake.wakeEvents.length - 2];
  assert.ok(second.messages[0].content[1].text.includes(latestEvent));
  assert.ok(!second.messages[0].content[0].text.includes("自动唤醒"));
});

test("WAKE_HISTORY_MESSAGES caps the cached history", () => {
  const conversation = [];
  for (let i = 1; i <= 10; i++) {
    conversation.push({ role: i % 2 ? "user" : "assistant", content: `第${i}条消息` });
  }
  conversation.push({ role: "assistant", content: "（2026-10-20 12:00 自动唤醒：本次未发送推送｜原因：测试）" });

  process.env.WAKE_HISTORY_MESSAGES = "3";
  try {
    const parts = wake.buildAnthropicWakeParts([{ role: "system", content: "人设" }, ...conversation], "唤醒提示");
    for (let i = 1; i <= 7; i++) assert.ok(!parts.historyText.includes(`第${i}条消息`), `message ${i} trimmed`);
    for (let i = 8; i <= 10; i++) assert.ok(parts.historyText.includes(`第${i}条消息`), `message ${i} kept`);
    assert.ok(!parts.historyText.includes("人设"));
    assert.ok(!parts.historyText.includes("自动唤醒"));
    assert.match(parts.variableText, /自动唤醒：本次未发送推送｜原因：测试/);
    assert.match(parts.variableText, /唤醒提示$/);
  } finally {
    delete process.env.WAKE_HISTORY_MESSAGES;
  }

  const defaults = wake.buildAnthropicWakeParts(conversation, "唤醒提示");
  for (let i = 1; i <= 10; i++) assert.ok(defaults.historyText.includes(`第${i}条消息`));
});

test("supports the optional one-hour cache TTL on both breakpoints", () => {
  process.env.WAKE_CACHE_TTL = "1h";
  try {
    const request = wake.buildAnthropicWakeRequest({ cleanSP: "人设", historyText: "记录", variableText: "规则" });
    assert.deepEqual(request.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
    assert.deepEqual(request.messages[0].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
    assert.equal(request.messages[0].content[1].cache_control, undefined);
  } finally {
    delete process.env.WAKE_CACHE_TTL;
  }
});

test("surfaces upstream errors instead of recording a fake event", async () => {
  const before = fake.wakeEvents.length;
  setReply(400, '{"type":"error","error":{"type":"invalid_request_error","message":"temperature is not supported"}}');
  await assert.rejects(wake.runWakeUp(), /HTTP 400/);
  assert.equal(fake.wakeEvents.length, before);
});
