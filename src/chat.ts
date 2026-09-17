/**
 * 多轮对话入口：在同一个终端里连续提问，agent 能记住上下文。
 *
 * 与 index.ts 的区别：
 * index.ts 每次运行都是全新会话 —— 提问的历史不会被保留。
 * chat.ts 给 agent 挂上了检查点，并用固定的 configurable.thread_id 做线程
 * 标识：每轮 invoke 都会先从该线程取回之前的全部消息、拼上当前提问再交给
 * 模型。所以可以追着上一轮的话题接着问，不必重复背景。
 *
 * 检查点用 SQLite 落盘（见 memory.ts）：Ctrl+C 后再 npm run chat，
 * 同一个 THREAD_ID 的历史还在。
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import type { BaseMessage } from "@langchain/core/messages";
import { agent } from "./agent.js";
import { DB_PATH, memory, threadMessageCount } from "./memory.js";

// LangGraph 里记忆的单位是「线程」（thread_id）：同一个线程共享历史。
// REPL 整个生命周期只在一条线程里，所以记忆自然连续。
const THREAD_ID = "default";

// 挂上落盘检查点。只在本入口挂，不影响 index.ts 一次一答的用法。
agent.checkpointer = memory;

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

console.log("多轮对话模式 —— agent 会记住上下文；输入 exit / quit 退出。");
console.log("示例：先问「2的10次方」，再追一句「那再加 10 呢」（不用重复 2 的 10 次方）。");
console.log(`记忆已落盘到 ${DB_PATH}，重启后接着聊仍在同一段上下文里。\n`);

// 记住上一轮结束时消息条数，只打印新产生的部分。
// 记忆落盘后线程里可能已有历史（上次运行的），所以先从检查点读出实际条数，
// 否则第一轮会把上次的旧消息当成「本轮新增」重打一遍。
let historyCount = await threadMessageCount(THREAD_ID);
if (historyCount > 0) {
  console.log(`（已从上次的对话恢复 ${historyCount} 条消息，可以直接接着问）\n`);
}

console.log("你："); // for await 不会自动打提示符，先打一次

for await (const raw of rl) {
  const input = raw.trim();
  if (/^(exit|quit|退出|q)$/i.test(input)) break;
  if (input) {
    try {
      const result = await agent.invoke(
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
  console.log("你："); // 下一次输入的提示符
}

rl.close();
console.log("\n再见。对话记忆已保存在本地，下次启动可以接着聊。");