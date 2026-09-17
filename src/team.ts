/**
 * 多 Agent 协作：主管-调度模式（supervisor）。
 *
 * 结构：
 *   主管（teamAgent）—— 一个普通 agent，但它的「工具」是两个专员 agent。
 *   专员（docsWorker / mathWorker）—— 各自是完整独立的 agent，有自己的
 *   工具集：文档问答专员握着 retrieve_docs，计算专员握着 calculator 和
 *   current_time。
 *
 * 工作方式：用户问题进来，主管判断意图、决定派哪个专员（可并行派多个），
 * 最后把专员的成果综合成答复。专员只在自己的领域里干活，看不到全局。
 *
 * 这就是 LangGraph 多 agent 里最经典的一种编排：agent 作为工具。
 * 层级可以一层套一层，每一层都是独立 agent。
 */
import { createAgent, tool } from "langchain";
import * as z from "zod";
import type { BaseMessage } from "@langchain/core/messages";
import { model } from "./agent.js";
import { calculator, currentTime } from "./tools.js";
import { retrieveDocs } from "./rag.js";

// —— 专员 agent ——

/** 文档问答专员：只懂知识库，回答前必须检索，检索不到不编造 */
const docsWorker = createAgent({
  model,
  tools: [retrieveDocs],
  systemPrompt:
    "你是「文档问答专员」，只回答项目本地知识库（docs/ 目录）相关的问题。" +
    "回答前先用 retrieve_docs 检索文档，基于检索结果作答；检索不到相关内容时如实说明，不要编造。",
});

/** 计算专员：只懂算术和时间，计算必须用工具，不心算 */
const mathWorker = createAgent({
  model,
  tools: [calculator, currentTime],
  systemPrompt:
    "你是「计算专员」，只负责算术计算和当前时间查询。计算必须调用 calculator 工具得出结果，禁止心算或估算。",
});

/** 取 agent 返回消息里最后一条 AI 文本（worker 若出错内容也在其中） */
function lastText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].getType() === "ai") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
    }
  }
  return "";
}

// —— 把专员包装成主管的工具 ——
// agent 作为工具：主管调用它，就像调用一个普通工具，等它内部自己跑完一轮。

const docsWorkerTool = tool(
  async ({ question }) => {
    const result = await docsWorker.invoke({
      messages: [{ role: "user", content: question }],
    });
    return lastText(result.messages);
  },
  {
    name: "docs_worker",
    description:
      "文档问答专员：回答与项目本地知识库相关的问题（使用说明、部署配置、接口协议等）。把用户的原问题完整传给该工具。",
    schema: z.object({
      question: z.string().describe("要问专员的问题原文"),
    }),
  },
);

const mathWorkerTool = tool(
  async ({ question }) => {
    const result = await mathWorker.invoke({
      messages: [{ role: "user", content: question }],
    });
    return lastText(result.messages);
  },
  {
    name: "math_worker",
    description: "计算专员：算术计算与当前时间查询。把用户的原问题完整传给该工具。",
    schema: z.object({
      question: z.string().describe("要问专员的问题原文"),
    }),
  },
);

// —— 主管 agent ——

/** 主管：不直接干活，判断意图、派活、汇总 */
export const teamAgent = createAgent({
  model,
  tools: [docsWorkerTool, mathWorkerTool],
  systemPrompt:
    "你是客服主管，手下有两个专员工具：docs_worker（项目知识库问答）、math_worker（算术计算与时间查询）。" +
    "规则：① 问题涉及知识库（使用说明、部署、配置、接口协议）→ 派 docs_worker；" +
    "② 涉及算术或时间 → 派 math_worker；③ 一项请求同时涉及两者时可并行调用多个专员；" +
    "④ 拿到专员结果后，用简洁的中文把最终答案组织给用户，不要照搬专员的检索过程。" +
    "不调用工具也能直接回答的寒暄问题，直接回答即可。",
});