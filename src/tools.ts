import { tool } from "langchain";
import * as z from "zod";

/**
 * 只放行数字、四则运算符、括号、小数点和空白字符。
 * 白名单里没有任何字母，因此表达式不可能构造出函数调用或标识符。
 */
const SAFE_EXPRESSION = /^[\d+\-*/().\s]+$/;

export const calculator = tool(
  ({ expression }) => {
    if (!SAFE_EXPRESSION.test(expression)) {
      return `无法计算：表达式只能包含数字和 + - * / ( ) 运算符，收到的是 "${expression}"`;
    }
    try {
      // 到这里表达式已通过白名单校验，只会求值纯算术运算
      const value = Function(`"use strict"; return (${expression});`)();
      return Number.isFinite(value) ? String(value) : `结果不是有限数：${value}`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `无法计算 "${expression}"：${reason}`;
    }
  },
  {
    name: "calculator",
    description: "计算一个算术表达式。表达式只能包含数字和 + - * / ( ) 运算符。",
    schema: z.object({
      expression: z.string().describe("要计算的算术表达式，例如 (23*17+9)/4"),
    }),
  },
);

export const currentTime = tool(
  () => new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
  {
    name: "current_time",
    description: "获取当前日期和时间。",
    schema: z.object({}),
  },
);
