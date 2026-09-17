/**
 * 多 Agent 协作演示入口：主管-调度模式。
 *
 * 与 chat.ts 相同风格的多轮交互，但内部是一个主管 + 两个专员 agent。
 * 渲染会按消息顺序展示完整链路：
 *   主管派活（→ 派活 xxx）→ 专员回话（← 专员汇报 xxx）→ 主管综合（【主管】xxx）
 *
 * 运行：npm run team
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import { teamAgent } from "./team.js";

const THREAD_ID = "team-demo";

// 挂上内存检查点：主管要记住多轮上下文（专员各自独立，无记忆）
teamAgent.checkpointer = new MemorySaver();

/** 专员可能带回完整文档片段，截断避免刷屏 */
const MAX_TOOL_OUTPUT = 300;

function render(newMessages: BaseMessage[]): string {
  const lines: string[] = [];
  for (const msg of newMessages) {
    if (msg.getType() === "ai") {
      const calls = (msg as {
        tool_calls?: { name: string; args?: unknown }[];
      }).tool_calls;
      if (calls?.length) {
        for (const call of calls) {
          lines.push(`→ 派活 ${call.name} ${JSON.stringify(call.args ?? {})}`);
        }
      }
      if (typeof msg.content === "string" && msg.content.trim()) {
        lines.push(`【主管】${msg.content}`);
      }
    } else if (msg.getType() === "tool") {
      const raw = msg.content;
      const out = typeof raw === "string" ? raw : JSON.stringify(raw);
      const clipped =
        out.length > MAX_TOOL_OUTPUT
          ? out.slice(0, MAX_TOOL_OUTPUT) + "…"
          : out;
      lines.push(`← 专员汇报 ${clipped}`);
    }
  }
  return lines.join("\n");
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log("多 Agent 协作模式 —— 主管会把活派给专员（文档问答 / 计算），例如：");
console.log("  先问「HTTP 服务怎么启动」，再问「那 2 的 10 次方呢」。exit / quit 退出。\n");

let historyCount = 0;

console.log("你：");

for await (const raw of rl) {
  const input = raw.trim();
  if (/^(exit|quit|退出|q)$/i.test(input)) break;
  if (input) {
    try {
      const result = await teamAgent.invoke(
        { messages: [{ role: "user", content: input }] },
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
console.log("\n再见。主管的记忆随进程结束而清空。");