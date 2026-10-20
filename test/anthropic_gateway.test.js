const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const test = require("node:test");
const assert = require("node:assert/strict");
const { formatDateTimeInTimeZone } = require("../time_utils");

// 批注 2026-10-20：起一个真实的 Gateway 子进程，上游换成本地假 Anthropic 服务，
// 验证 /v1/messages 的鉴权、头部、逐字节透传、只追加注入、SSE 直通和错误原样返回。
const GATEWAY_KEY = "gw-test-key-123";
const UPSTREAM_KEY = "sk-ant-upstream-test-456";
const TIME_ZONE = "Europe/London";
const SECRET_TEXT = "这是一句不该出现在日志里的悄悄话";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error("waitFor timed out");
}

const upstream = {
  requests: [],
  handler: null,
  server: null,
  port: 0
};

const gateway = {
  child: null,
  port: 0,
  dataDir: "",
  output: ""
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function jsonUpstream(status, payload) {
  return (req, res) => {
    res.writeHead(status, { "Content-Type": "application/json", "request-id": "req_test_1" });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  };
}

function textReply(text, signature = "sig-default") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature },
      { type: "text", text }
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 }
  };
}

async function postMessages(body, headers = {}) {
  return fetch(`http://127.0.0.1:${gateway.port}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": GATEWAY_KEY,
      "anthropic-version": "2023-06-01",
      ...headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

function lastUpstreamBody() {
  return JSON.parse(upstream.requests[upstream.requests.length - 1].body);
}

test.before(async () => {
  upstream.server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      upstream.requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      (upstream.handler || jsonUpstream(200, textReply("默认回复")))(req, res);
    });
  });
  await new Promise(resolve => upstream.server.listen(0, "127.0.0.1", resolve));
  upstream.port = upstream.server.address().port;

  gateway.port = await freePort();
  gateway.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-anthropic-gateway-"));
  const env = { ...process.env };
  for (const key of ["DATA_DIR", "RAILWAY_VOLUME_MOUNT_PATH", "TARGET_API_URL", "TARGET_API_KEY"]) delete env[key];
  Object.assign(env, {
    PORT: String(gateway.port),
    DATA_DIR: gateway.dataDir,
    // Railway 模式下 readEnvValue 以进程环境为准，不受开发机 .env 影响。
    RAILWAY_ENVIRONMENT: "test",
    ALLOW_PUBLIC_API: "true",
    GATEWAY_API_KEY: GATEWAY_KEY,
    ANTHROPIC_API_URL: `http://127.0.0.1:${upstream.port}/v1/messages`,
    ANTHROPIC_API_KEY: UPSTREAM_KEY,
    TIME_ZONE,
    REQUEST_BODY_LIMIT_MB: "5"
  });
  gateway.child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    cwd: path.join(__dirname, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  gateway.child.stdout.on("data", chunk => { gateway.output += chunk.toString(); });
  gateway.child.stderr.on("data", chunk => { gateway.output += chunk.toString(); });

  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${gateway.port}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }, 10000);
});

test.after(async () => {
  if (gateway.child) {
    gateway.child.kill("SIGTERM");
    await new Promise(resolve => gateway.child.once("exit", resolve));
  }
  await new Promise(resolve => upstream.server.close(resolve));
  fs.rmSync(gateway.dataDir, { recursive: true, force: true });
});

test("authenticates /v1/messages with x-api-key or Bearer", async () => {
  upstream.handler = jsonUpstream(200, textReply("好的"));
  const body = { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "在吗" }] };

  const missing = await fetch(`http://127.0.0.1:${gateway.port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(missing.status, 401);

  const wrong = await postMessages(body, { "x-api-key": "not-the-key" });
  assert.equal(wrong.status, 401);

  const before = upstream.requests.length;
  const viaHeader = await postMessages(body);
  assert.equal(viaHeader.status, 200);

  const viaBearer = await fetch(`http://127.0.0.1:${gateway.port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_KEY}` },
    body: JSON.stringify(body)
  });
  assert.equal(viaBearer.status, 200);
  assert.equal(upstream.requests.length, before + 2, "rejected requests never reach the upstream");
});

test("swaps the client key for the upstream key and forwards anthropic headers", async () => {
  upstream.handler = jsonUpstream(200, textReply("收到"));
  const res = await postMessages(
    { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "头部测试" }] },
    { "anthropic-beta": "thinking-binding-controls-2026-08-01", "anthropic-version": "2023-06-01" }
  );
  assert.equal(res.status, 200);
  const forwarded = upstream.requests[upstream.requests.length - 1];
  assert.equal(forwarded.url, "/v1/messages");
  assert.equal(forwarded.headers["x-api-key"], UPSTREAM_KEY);
  assert.equal(forwarded.headers.authorization, undefined);
  assert.equal(forwarded.headers["anthropic-beta"], "thinking-binding-controls-2026-08-01");
  assert.equal(forwarded.headers["anthropic-version"], "2023-06-01");
  assert.equal(res.headers.get("request-id"), "req_test_1");

  // 客户端不带 anthropic-version 时使用默认值。
  await fetch(`http://127.0.0.1:${gateway.port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": GATEWAY_KEY },
    body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, messages: [{ role: "user", content: "无版本头" }] })
  });
  const defaulted = upstream.requests[upstream.requests.length - 1];
  assert.equal(defaulted.headers["anthropic-version"], "2023-06-01");
  assert.equal(defaulted.headers["anthropic-beta"], undefined);
});

test("passes earlier messages through byte-identical and injects wake events only into the last user message", async () => {
  const system = [
    { type: "text", text: `你是Dylan。${SECRET_TEXT}`, cache_control: { type: "ephemeral" } }
  ];
  const extras = {
    thinking: { type: "adaptive", display: "summarized", block_binding: { mode: "strict", note: "opaque" } },
    output_config: { effort: "high" },
    tools: [{ name: "get_time", description: "读时间", input_schema: { type: "object", properties: {} } }]
  };
  const u1 = { role: "user", content: [{ type: "text", text: "早安" }] };

  // 第一轮：建立“上一轮 assistant 回复”的时间下界。
  upstream.handler = jsonUpstream(200, textReply("早安呀，小猫", "sig-A1"));
  const first = await postMessages({ model: "claude-opus-5-5", max_tokens: 1000, system, ...extras, messages: [u1] });
  assert.equal(first.status, 200);
  await waitFor(() => readJson(path.join(gateway.dataDir, "native_injections.json"))?.last_reply_at);

  // 用户沉默期间 wake-up 记录了一次推送。
  const eventContent = `（${formatDateTimeInTimeZone(new Date(), TIME_ZONE)} 刚刚给用户发了ntfy推送：想你｜在干嘛）`;
  const eventRes = await fetch(`http://127.0.0.1:${gateway.port}/internal/wake-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: eventContent })
  });
  assert.equal(eventRes.status, 200);

  const a1 = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "她醒了。 \"引号\"\\反斜杠 emoji😀", signature: "EqQBCkYIBRgCKkB+/sig==A1签名" },
      { type: "text", text: "早安呀，小猫" }
    ]
  };
  const u2 = { role: "user", content: [{ type: "text", text: "我刚醒", cache_control: { type: "ephemeral" } }] };
  const secondBody = { model: "claude-opus-5-5", max_tokens: 1000, system, ...extras, messages: [u1, a1, u2] };

  upstream.handler = jsonUpstream(200, textReply("醒啦", "sig-A2"));
  const second = await postMessages(secondBody);
  assert.equal(second.status, 200);
  const sentRaw = upstream.requests[upstream.requests.length - 1].body;
  const sent = JSON.parse(sentRaw);

  assert.deepEqual(sent.system, system);
  assert.deepEqual(sent.thinking, extras.thinking);
  assert.deepEqual(sent.output_config, extras.output_config);
  assert.deepEqual(sent.tools, extras.tools);
  assert.equal(JSON.stringify(sent.messages[0]), JSON.stringify(u1));
  assert.equal(JSON.stringify(sent.messages[1]), JSON.stringify(a1));
  assert.ok(sentRaw.includes(JSON.stringify(a1.content[0].signature)), "signature forwarded verbatim");

  const injected = sent.messages[2];
  assert.equal(injected.role, "user");
  assert.equal(injected.content.length, u2.content.length + 1);
  assert.equal(injected.content[0].type, "text");
  assert.match(injected.content[0].text, /网关附注/);
  assert.ok(injected.content[0].text.includes(eventContent));
  assert.deepEqual(injected.content.slice(1), u2.content);
  await waitFor(() => readJson(path.join(gateway.dataDir, "native_injections.json"))?.entries?.length === 1);

  // 重新生成同一轮：附注逐字节相同，事件不重复。
  upstream.handler = jsonUpstream(200, textReply("醒啦", "sig-A2"));
  await postMessages(secondBody);
  assert.equal(JSON.stringify(lastUpstreamBody().messages[2]), JSON.stringify(injected));

  // 下一轮：Kelivo 发回的是不带附注的 u2 原文，网关要把上游见过的版本原样补回，前缀保持不变。
  const a2 = { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig-A2" }, { type: "text", text: "醒啦" }] };
  const u3 = { role: "user", content: "今天去图书馆" };
  upstream.handler = jsonUpstream(200, textReply("好", "sig-A3"));
  await postMessages({ model: "claude-opus-5-5", max_tokens: 1000, system, ...extras, messages: [u1, a1, u2, a2, u3] });
  const third = lastUpstreamBody();
  assert.equal(JSON.stringify(third.messages[0]), JSON.stringify(u1));
  assert.equal(JSON.stringify(third.messages[1]), JSON.stringify(a1));
  assert.equal(JSON.stringify(third.messages[2]), JSON.stringify(injected));
  assert.equal(JSON.stringify(third.messages[3]), JSON.stringify(a2));
  assert.equal(JSON.stringify(third.messages[4]), JSON.stringify(u3), "no new events, last message untouched");
  assert.deepEqual(third.system, system);
});

test("streams SSE straight through and records the assistant text afterwards", async () => {
  const events = [
    { type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", content: [], model: "claude-opus-5-5", usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想一想" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-stream" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "流式回复" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "来啦" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" }
  ];
  const sse = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  upstream.handler = (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    // 拆成不对齐的小块，确认网关的增量解析不依赖分块边界。
    const buffer = Buffer.from(sse, "utf8");
    let offset = 0;
    const step = () => {
      if (offset >= buffer.length) return res.end();
      res.write(buffer.subarray(offset, offset + 37));
      offset += 37;
      setImmediate(step);
    };
    step();
  };

  const res = await postMessages({
    model: "claude-opus-5-5",
    max_tokens: 1000,
    stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: "流式测试" }] }]
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const received = await res.text();
  assert.equal(received, sse);
  assert.equal(JSON.parse(upstream.requests[upstream.requests.length - 1].body).stream, true);

  const timeline = await waitFor(() => {
    const data = readJson(path.join(gateway.dataDir, "enhanced_messages.json"));
    return Array.isArray(data) && data.some(msg => msg.role === "assistant" && msg.content === "流式回复来啦") ? data : null;
  });
  // 没有时间前缀的用户消息在时间线里被补上时间，wake_up.js 才能算出沉默时长。
  const lastUser = [...timeline].reverse().find(msg => msg.role === "user");
  assert.match(lastUser.content, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} 流式测试$/);
});

test("returns non-streaming JSON responses unchanged", async () => {
  const payload = JSON.stringify(textReply("非流式回复", "sig-ns"));
  upstream.handler = jsonUpstream(200, payload);
  const res = await postMessages({ model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "非流式" }] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.equal(await res.text(), payload);
  await waitFor(() => {
    const data = readJson(path.join(gateway.dataDir, "enhanced_messages.json"));
    return Array.isArray(data) && data.some(msg => msg.role === "assistant" && msg.content === "非流式回复");
  });
});

test("returns upstream errors with the original status and body", async () => {
  const errorBody = '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: invalid thinking signature"}}';
  upstream.handler = jsonUpstream(400, errorBody);
  for (const stream of [false, true]) {
    const res = await postMessages({ model: "claude-opus-5-5", max_tokens: 100, stream, messages: [{ role: "user", content: "会报错" }] });
    assert.equal(res.status, 400);
    assert.equal(await res.text(), errorBody);
  }
});

test("never writes keys or message bodies to the logs", async () => {
  await sleep(100);
  assert.ok(gateway.output.length > 0);
  assert.ok(!gateway.output.includes(UPSTREAM_KEY));
  assert.ok(!gateway.output.includes(GATEWAY_KEY));
  assert.ok(!gateway.output.includes(SECRET_TEXT));
  assert.ok(!gateway.output.includes("我刚醒"));
});
