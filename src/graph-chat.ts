/**
 * 手写状态图演示入口：和 chat.ts 一样的多轮对话，但驱动它的是一张
 * 手工绘制的 StateGraph（见 src/graph.ts），不是 createAgent 的隐藏循环。
 *
 * 运行：npm run graph
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { graphAgent } from "./graph.js";

// 同一线程的多轮对话；每轮入口把 steps 归零，避免上一轮的循环预算被带进来
const THREAD_ID = "graph-demo";

console.log("这张图是手工搭建的（模型节点 ⟷ 工具节点 + 条件边）：\n");
console.log("  START → model ──有工具调用──▶ tools ──▶ model");
console.log("                └──没有───────▶ END\n");

const rl = createInterface({ input: process.stdin, output: process.stdout });

/** 把本轮新增的消息渲染成终端文本：工具调用 + 最终回复 */
function render(newMessages: BaseMessage[]): string {
  const lines: string[] = [];
  for (const msg of newMessages) {
    if (msg.getType() === "ai") {
      const calls = (msg as { tool_calls?: { name: string; args?: unknown }[] })
        .tool_calls;
      if (calls?.length) {
        for (const call of calls) {
          lines.push(`→ ${call.name} 入参 ${JSON.stringify(call.args)}`);
        }
      }
      if (typeof msg.content === "string" && msg.content.trim()) {
        lines.push(msg.content);
      }
    } else if (msg.getType() === "tool") {
      const out = msg.content;
      lines.push(
        `← 工具返回 ${typeof out === "string" ? out : JSON.stringify(out)}`,
      );
    }
  }
  return lines.join("\n");
}

console.log("多轮对话（手绘状态图）—— 输入 exit / quit 退出。\n");

let historyCount = 0;

console.log("你：");

for await (const raw of rl) {
  const input = raw.trim();
  if (/^(exit|quit|退出|q)$/i.test(input)) break;
  if (input) {
    try {
      const result = await graphAgent.invoke(
        { messages: [new HumanMessage(input)], steps: 0 },
        { configurable: { thread_id: THREAD_ID } },
      );
      const fresh = result.messages.slice(historyCount);
      historyCount = result.messages.length;
      console.log(`\nAI：${render(fresh)}\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`\n出错了：${reason}\n`);
    }
  }
  console.log("你：");
}

rl.close();
console.log("\n再见。");