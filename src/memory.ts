/**
 * 对话持久化：把内存里的记忆换成落盘的 SQLite。
 *
 * 之前的 chat.ts / server.ts 用的是 MemorySaver —— 记忆只活在进程内存里，
 * 进程一停（Ctrl+C、重启服务）历史就没了。这里换成 SqliteSaver，把检查点
 * 写进本地 .data/memory.db：
 *
 *   - 关掉服务、重新 npm run server，同一个 sessionId 接着问，它还记得上文
 *   - 想清空记忆，删掉 .data/memory.db 即可（或 npm run memory:clear）
 *
 * 用法上和 MemorySaver 完全一致 —— 都是 BaseCheckpointSaver，挂在 agent 的
 * checkpointer 上就行，thread_id 依然是记忆的单位。区别只在「活在哪」。
 *
 * 注意：SQLite 连接是进程级独占的（写锁），所以不要把同一份 db 文件同时
 * 开在多个进程里（比如 server 和 chat 同时跑）。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

/** 数据库文件位置：项目根目录 .data/memory.db（已 gitignore） */
export const DB_PATH = path.resolve(process.cwd(), ".data/memory.db");

mkdirSync(path.dirname(DB_PATH), { recursive: true }); // 首次运行时建目录

/**
 * 落盘检查点。SqliteSaver 自己会建表，不需要手动初始化 schema。
 * 这里导出一个实例，让各入口共用同一份连接。
 */
export const memory = SqliteSaver.fromConnString(DB_PATH);

/**
 * 某个线程里已存了多少条消息（没存过返回 0）。
 *
 * 用途：落盘之后线程里可能带着上次运行的旧消息，入口程序需要先知道
 * 「已经有多少条」，才能只打印本次新增的部分，而不是把陈年旧账重打一遍。
 * agent.getState 在 langchain 1.x 里被标成 internal（返回 never），
 * 所以直接问 checkpointer 要检查点。
 */
export async function threadMessageCount(threadId: string): Promise<number> {
  const tuple = await memory.getTuple({
    configurable: { thread_id: threadId },
  });
  const values = (tuple?.checkpoint as { channel_values?: { messages?: unknown } })
    ?.channel_values;
  return Array.isArray(values?.messages) ? values.messages.length : 0;
}
