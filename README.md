# langchain-agent

基于 LangChain 的 TypeScript AI Agent 示例：一个能调用工具的对话式 Agent，带流式输出，可对接任意 OpenAI 兼容接口的模型供应商。

## 功能

- 支持自定义 API 地址、模型名、API Key（OpenAI 兼容接口）
- 内置两个工具：
  - `calculator`：计算算术表达式，白名单安全校验（仅允许数字与 `+ - * / ( )`，杜绝注入）
  - `current_time`：获取当前日期和时间
- 流式输出：实时打印模型的 token 增量与工具调用过程（`streamEvents` v2）
- 配置二选一：`.env` 文件或系统环境变量，环境变量优先

## 环境要求

- Node.js 18+
- npm

## 安装

```bash
npm install
```

## 配置

需要三个值，全部由你的模型供应商提供：

| 变量名 | 说明 |
| ------ | ---- |
| `AGENT_BASE_URL` | 供应商接口地址，通常以 `/v1` 结尾 |
| `AGENT_MODEL` | 模型名，按供应商文档填写 |
| `AGENT_API_KEY` | API Key |

两种方式任选其一（已存在的环境变量优先，`.env` 兜底）：

**方式一：`.env` 文件**（推荐，已加入 `.gitignore`）

在项目根目录创建 `.env`，填入三个变量：

```bash
AGENT_BASE_URL=https://api.example.com/v1
AGENT_MODEL=your-model-name
AGENT_API_KEY=your-api-key
```

**方式二：系统环境变量**

以 `setx` 为例（写入用户级环境变量，新终端生效）：

```bash
setx AGENT_BASE_URL "https://api.example.com/v1"
setx AGENT_MODEL "your-model-name"
setx AGENT_API_KEY "your-api-key"
```

## 使用

```bash
npm start -- "你的问题"
```

示例输出（会实时展示模型生成与工具调用过程）：

```
提问：2的10次方是多少？

→ calculator 入参 {"expression":"2*2*2*2*2*2*2*2*2*2"}
← calculator 返回 1024

模型：
2 的 10 次方是 **1024**。
```

## 多轮对话（记忆）

```bash
npm run chat
```

进入交互式对话，同一进程内 agent 会记住上下文，可以追着上一轮接着问（`exit` / `quit` 退出）。

```
你：2的10次方是多少？
AI：2 的 10 次方是 **1024**。

你：那再加 10 呢？     ← 不用重复“2 的 10 次方”，agent 记得
AI：2 的 10 次方是 1024，再加 10 就是 **1034**。
```

实现方式：给 agent 挂 `MemorySaver` 检查点，并以固定 `thread_id` 作为线程标识（见 `src/chat.ts`）。记忆只存在于单次运行的内存里，进程退出即清空。

## HTTP 服务（SSE 流式）

```bash
npm run server
```

启动后监听 `3000` 端口（可用 `PORT` 环境变量修改），提供 `POST /chat`：

```bash
curl -N -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"2的10次方是多少？","sessionId":"s1"}'
```

响应是 SSE 流，每行 `data:` 是一条 JSON 事件：

| 事件类型 | 含义 |
| -------- | ---- |
| `{"type":"token","content":"..."}` | 模型 token 增量（打字机） |
| `{"type":"tool","name":"calculator","data":...}` | 工具被调用 |
| `{"type":"tool_result","name":"calculator","data":...}` | 工具返回 |
| `{"type":"done"}` | 本轮回答结束 |
| `{"type":"error","message":"..."}` | 出错 |

`sessionId` 映射到 LangGraph 线程：**同名会话共享上下文**，可带同一 `sessionId` 多轮追问，不同 `sessionId` 互相隔离（记忆在服务进程内存中，重启即清空）。

## 项目结构

```
src/
  agent.ts     Agent 编排：模型实例 + 工具注册（createAgent）
  tools.ts     自定义工具：calculator、current_time
  index.ts     流式 CLI 入口：streamEvents 监听并打印事件
  chat.ts      多轮对话入口：MemorySaver 检查点 + 固定 thread_id
  server.ts    HTTP 服务入口：POST /chat，SSE 流式返回
```

## 原理简述

`agent.streamEvents()` 把 Agent 内部的每一步作为事件实时推出，核心事件：

- `on_chat_model_stream` — 模型 token 增量（打字机效果的来源）
- `on_tool_start` / `on_tool_end` — 工具调用与返回（`data.input` / `data.output`）

一次提问可能触发多轮「模型 → 工具 → 模型」循环；并行工具调用时用 `run_id` 配对调用与返回。