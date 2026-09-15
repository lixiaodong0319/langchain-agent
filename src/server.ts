/**
 * HTTP 服务入口：把 agent 包装成 POST /chat 接口，用 SSE（Server-Sent Events）流式返回。
 *
 * 请求（JSON）：
 *   { "message": "2的10次方是多少？", "sessionId": "s1" }
 *   sessionId 可选：同名 sessionId 共享记忆（映射到 LangGraph 的 thread_id），
 *   不同 sessionId 互相隔离；不传则用 "default"。
 *
 * 响应是 text/event-stream，每行 `data: <json>` 是一条事件：
 *   {"type":"token","content":"2"}                       模型 token 增量（打字机）
 *   {"type":"tool","name":"calculator","data":{...}}     工具被调用
 *   {"type":"tool_result","name":"calculator","data":...} 工具返回
 *   {"type":"done"}                                      本轮回答结束
 *   出错时：{"type":"error","message":"..."}
 *
 * 用 curl 测试：
 *   curl -N -X POST http://localhost:3000/chat \
 *     -H 'Content-Type: application/json' \
 *     -d '{"message":"2的10次方是多少？","sessionId":"s1"}'
 */
import "dotenv/config";
import express from "express";
import { MemorySaver } from "@langchain/langgraph";
import { agent } from "./agent.js";

const PORT = Number(process.env.PORT ?? 3000);

// 挂上内存检查点：同一 sessionId 的多次请求共享历史（进程内存，重启即失）
agent.checkpointer = new MemorySaver();

const app = express();
app.use(express.json());

// 允许浏览器跨域调用（开发用；生产环境应收敛来源）
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.post("/chat", async (req, res) => {
  const body = (req.body ?? {}) as { message?: unknown; sessionId?: string };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "message 字段不能为空" });
    return;
  }
  const sessionId = body.sessionId ?? "default";

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // run_id 把「工具调用 / 工具返回」配对起来，并行调用时才不会张冠李戴
  const pendingTools = new Map<string, string>();

  /** 工具返回值可能是字符串，也可能是 LangChain 的 ToolMessage（真实内容在 .content 上） */
  const shortOutput = (value: unknown): unknown => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "content" in value) {
      const content = (value as { content?: unknown }).content;
      if (typeof content === "string") return content;
    }
    return value;
  };

  try {
    const events = await agent.streamEvents(
      { messages: [{ role: "user", content: message }] },
      { version: "v2", configurable: { thread_id: `session:${sessionId}` } },
    );

    for await (const event of events) {
      switch (event.event) {
        case "on_chat_model_stream": {
          const chunk = event.data?.chunk as { content?: unknown } | undefined;
          const text = typeof chunk?.content === "string" ? chunk.content : "";
          if (text) send({ type: "token", content: text });
          break;
        }
        case "on_tool_start": {
          pendingTools.set(event.run_id, event.name);
          send({ type: "tool", name: event.name, data: event.data?.input });
          break;
        }
        case "on_tool_end": {
          const name = pendingTools.get(event.run_id) ?? event.name;
          pendingTools.delete(event.run_id);
          send({ type: "tool_result", name, data: shortOutput(event.data?.output) });
          break;
        }
      }
    }
    send({ type: "done" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    send({ type: "error", message: reason });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`HTTP 服务已启动：http://localhost:${PORT}`);
  console.log('POST /chat  {"message":"你的问题","sessionId":"可选会话id"}');
});