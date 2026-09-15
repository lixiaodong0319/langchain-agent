import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { calculator, currentTime } from "./tools.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `缺少环境变量 ${name}：在系统环境变量中设置它，或在项目根目录的 .env 文件中填入该值。`,
    );
  }
  return value;
}

// 变量名刻意不用 OPENAI_* 前缀：系统里如果已存在同名变量，dotenv 不会覆盖它，
// .env 里填的值会被静默忽略。自定义前缀可彻底避开这类冲突。
// 另外 openai SDK 自己也会读 OPENAI_API_KEY / OPENAI_BASE_URL，
// 所以这里必须显式传参，不能依赖它的默认回退。
//
// 用 ChatOpenAI 实例而不是 "openai:模型名" 字符串简写：
// 只有实例才能挂 baseURL，第三方供应商必须靠它换接口地址。
// 这里不传 temperature —— 部分供应商的模型不接受该参数，会直接报错。
const model = new ChatOpenAI({
  model: requiredEnv("AGENT_MODEL"),
  apiKey: requiredEnv("AGENT_API_KEY"),
  configuration: {
    baseURL: requiredEnv("AGENT_BASE_URL"),
  },
});

export const agent = createAgent({
  model,
  tools: [calculator, currentTime],
});
