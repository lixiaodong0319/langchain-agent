/**
 * 流式 + 可观测版入口。
 *
 * 与 agent.invoke() 的区别：
 * invoke() 要等整个 agent 跑完才返回最终状态，中间过程完全看不到。
 * streamEvents() 则把 agent 内部的每一步都作为事件实时推出来 ——
 * 模型何时开始生成、吐了哪些 token、调用了哪个工具、传了什么参数、
 * 工具又返回了什么，全部可见。
 *
 * 学习时要重点理解的三个事件：
 *   on_chat_model_stream —— 模型每生成一小段就推一次，是实现打字机效果的来源
 *   on_tool_start        —— agent 决定调用某个工具，data.input 是模型给出的参数
 *   on_tool_end          —— 工具执行完毕，data.output 是要回灌给模型的观察结果
 *
 * 一次提问可能触发多轮「模型 → 工具 → 模型」；模型也可能在一轮里同时决定调用
 * 多个工具（并行调用），此时事件顺序是 start、start、end、end，
 * 所以下面用 run_id 把每个工具的调用和返回配对起来。
 */
import "dotenv/config";
import { agent } from "./agent.js";

const question = process.argv.slice(2).join(" ").trim();

if (!question) {
  console.error('用法: npm start -- "你的问题"');
  process.exit(1);
}

const events = await agent.streamEvents(
  { messages: [{ role: "user", content: question }] },
  { version: "v2" },
);

/**
 * 事件里的工具入参是 { input: '{"expression":"..."}' } 这种形态 ——
 * 真正的内容是一段 JSON 字符串，解析出来才好读。
 */
function formatToolInput(data: unknown): string {
  const raw = (data as { input?: unknown } | undefined)?.input;
  if (typeof raw === "string") {
    try {
      return JSON.stringify(JSON.parse(raw));
    } catch {
      return raw;
    }
  }
  return JSON.stringify(raw);
}

/** 工具返回值可能是字符串，也可能是 LangChain 的 ToolMessage（内容在 .content 上） */
function formatToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "content" in value) {
    const content = (value as { content: unknown }).content;
    if (typeof content === "string") return content;
  }
  return JSON.stringify(value);
}

// 记录还没返回的工具调用，用于给返回结果标上来源
const pendingTools = new Map<string, string>();

// 模型的 token 是碎着推过来的，用标志控制「模型：」前缀只打一次
let isStreamingText = false;
let tokenChunks = 0;

console.log(`提问：${question}`);

for await (const event of events) {
  switch (event.event) {
    case "on_chat_model_stream": {
      const chunk = event.data?.chunk as { content?: unknown } | undefined;
      const text = typeof chunk?.content === "string" ? chunk.content : "";
      if (text.length > 0) {
        tokenChunks += 1;
        if (!isStreamingText) {
          console.log("\n模型：");
          isStreamingText = true;
        }
        process.stdout.write(text);
      }
      break;
    }

    case "on_chat_model_end": {
      if (isStreamingText) {
        process.stdout.write("\n");
        isStreamingText = false;
      }
      break;
    }

    case "on_tool_start": {
      pendingTools.set(event.run_id, event.name);
      console.log(`\n→ ${event.name} 入参 ${formatToolInput(event.data?.input)}`);
      break;
    }

    case "on_tool_end": {
      // 用 run_id 找回是哪个工具，并行调用时才不会张冠李戴
      const name = pendingTools.get(event.run_id) ?? event.name;
      pendingTools.delete(event.run_id);
      console.log(`← ${name} 返回 ${formatToolOutput(event.data?.output)}`);
      break;
    }
  }
}

console.log(`\n（本次共收到 ${tokenChunks} 个 token 增量事件）`);
