/**
 * 手写状态图：一个完全自己搭建的 ReAct Agent —— createAgent 底下就是这个循环。
 *
 * 之前几个入口都用 createAgent（LangChain 封装好的黑盒）。这一份把它的
 * 内部结构亲手画出来：状态在哪定义、节点怎么读写、图在哪里分叉，
 * 每一步都可以看到。
 *
 *   状态（AgentState）
 *     messages  全部对话消息，reducer 决定新消息怎么接进历史
 *     steps     本轮已执行几轮工具，作为循环预算防死循环
 *
 *   节点（addNode）
 *     model   「系统提示 + 全部历史」→ LLM → 一条 AI 消息
 *     tools   执行最近 AI 消息里的工具调用 → ToolMessage
 *
 *   边（addEdge / addConditionalEdges）
 *     START → model →（有工具调用 ? tools → model : END）
 */
import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import {
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { model } from "./agent.js";
import { calculator, currentTime } from "./tools.js";
import { retrieveDocs } from "./rag.js";

// —— 状态：整个图的"记忆"。节点只读写这个对象的字段。 ——

const AgentState = Annotation.Root({
  /** 全部对话消息 */
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right), // 累积式：新消息接到历史后面
    default: () => [],
  }),
  /**
   * 循环预算：本轮执行了几轮工具。刻意用「覆盖式」reducer ——
   * checkpointer 会把状态跨轮保存，若用累加式，上一轮的步数会污染下一轮
   * （几轮之后就永远超预算直接结束）。覆盖式 + 每轮入口传 steps:0 重新计数。
   */
  steps: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
});

/** 工具执行预算：超过后强制结束，防止模型无限循环 */
const MAX_TOOL_ROUNDS = 4;

/** 系统提示：createAgent 把 systemPrompt 藏在 agent 内部；这里由我们自己注入 */
const SYSTEM_PROMPT = new SystemMessage(
  "你是智能助手，可用工具：calculator（算术计算）、current_time（当前时间）、" +
    "retrieve_docs（本地知识库检索）。涉及知识库/使用说明/部署/配置/接口的问题先" +
    " retrieve_docs 再回答；需要计算的用 calculator 精确计算；其余可直接回答。",
);

const TOOLS = [calculator, currentTime, retrieveDocs];
const TOOL_BY_NAME = new Map<string, (arg: unknown) => Promise<unknown>>(
  // 工具们各自有独立的 zod schema，invoke 签名是 union，这里断言成统一接口
  TOOLS.map((t) => [
    t.name,
    (arg) => (t.invoke as (x: unknown) => Promise<unknown>)(arg),
  ]),
);

// —— 节点：每个吃进旧状态，吐出新消息/新字段的增量 ——

/** 把工具 schema 绑定给模型（createAgent 内部也是这样做的）：
 *  不 bind，LLM 根本不知道这些工具存在，只会把调用意图写成文本而不是
 *  结构化的 tool_calls，后面的工具节点就无从执行。 */
const toolModel = model.bindTools(TOOLS);

/** 模型节点：把「系统提示 + 全部历史」交给 LLM，产出一条 AI 消息 */
async function modelNode(state: typeof AgentState.State) {
  const response = await toolModel.invoke([SYSTEM_PROMPT, ...state.messages]);
  // 部分兼容接口的模型把工具调用标注写进 content（如 <｜tool_calls｜>）。
  // 已有结构化 tool_calls 后这段标注是噪音（createAgent 内部也会剥掉），这里手动清空。
  if (response.tool_calls?.length) response.content = "";
  return { messages: [response] };
}

/** 工具节点：并行执行最近 AI 消息里的全部工具调用，产出 ToolMessage */
async function toolsNode(state: typeof AgentState.State) {
  const last = state.messages.at(-1);
  if (last?.getType() !== "ai") return {};
  const calls = (last as AIMessage).tool_calls ?? [];
  const results = await Promise.all(
    calls.map(async (call) => {
      const run = TOOL_BY_NAME.get(call.name);
      if (!run) {
        return new ToolMessage({
          content: `未知工具：${call.name}`,
          tool_call_id: call.id ?? "",
        });
      }
      const out = await run(call.args);
      return new ToolMessage({
        content: typeof out === "string" ? out : JSON.stringify(out),
        tool_call_id: call.id ?? "",
        name: call.name,
      });
    }),
  );
  return { messages: results, steps: state.steps + 1 };
}

// —— 条件边：图的分叉点。返回值是下一步走到哪个节点，返回 END 即结束 ——

function shouldContinue(state: typeof AgentState.State): string {
  if (state.steps >= MAX_TOOL_ROUNDS) return END; // 预算耗尽，强制结束
  const last = state.messages.at(-1);
  if (last?.getType() === "ai") {
    const calls = (last as AIMessage).tool_calls;
    if (calls?.length) return "tools"; // 模型要求调用工具 → 交给工具节点
  }
  return END; // 模型直接给出了最终回答 → 结束
}

// —— 组装成图 ——

export const graphAgent = new StateGraph(AgentState)
  .addNode("model", modelNode)
  .addNode("tools", toolsNode)
  .addEdge(START, "model")
  .addConditionalEdges("model", shouldContinue, { tools: "tools", [END]: END })
  .addEdge("tools", "model")
  .compile({ checkpointer: new MemorySaver() });