# langchain-agent

基于 LangChain 的 TypeScript AI Agent 示例：一个能调用工具的对话式 Agent，带流式输出，可对接任意 OpenAI 兼容接口的模型供应商。

## 功能

- 支持自定义 API 地址、模型名、API Key（OpenAI 兼容接口）
- 内置两个工具：
  - `calculator`：计算算术表达式，白名单安全校验（仅允许数字与 `+ - * / ( )`，杜绝注入）
  - `current_time`：获取当前日期和时间
- 流式输出：实时打印模型的 token 增量与工具调用过程（`streamEvents` v2）
- 配置二选一：`.env` 文件或系统环境变量，环境变量优先
- 多 Agent 协作：一个主管 agent 把任务派给专员 agent（文档问答 / 计算），agent 作为工具逐层编排

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

## 本地文档问答（RAG）

把知识文档（`.md` / `.txt`）放进 `docs/` 目录，模型在回答相关问题时会检索文档内容：

```bash
npm run chat
# 你：HTTP 服务怎么启动？
```

实现（见 `src/rag.ts`）：文档 → 切分（500 字符/50 重叠）→ Embedding 向量化 → 查询时余弦相似度 top-3，结果作为 `retrieve_docs` 工具返回给模型。三个入口（CLI / chat / HTTP）以及 team 里的文档专员都会自动获得该工具。

- 索引首次使用时构建，改文档需重启进程生效
- Embedding 用**本地模型**（transformers.js + ONNX，离线免费）：默认 `Xenova/bge-small-zh-v1.5`（中文效果好），首次使用自动下载约 100MB 到 `.cache/`，之后离线可用；可在 `.env` 用 `AGENT_EMBEDDING_MODEL` 换成其他模型

## 多 Agent 协作（主管-调度）

```bash
npm run team
```

进入交互式对话（与 `chat` 同样支持多轮记忆）。内部有 3 个 agent 分工：一个**主管**、两个**专员**（文档问答专员、计算专员）。专员是完整的独立 agent，各有自己的工具（`retrieve_docs` / `calculator` + `current_time`），被包装成主管的「工具」；主管负责判断意图、派活（必要时并行）、汇总成最终答复。终端按消息顺序展示完整链路：

```
→ 派活 math_worker {"question":"2的10次方是多少？"}
← 专员汇报 2 的 10 次方 = **1024**
【主管】2 的 10 次方等于 **1024**。
```

实现见 `src/team.ts`：`createAgent` 造出专员，用 `tool()` 把 `worker.invoke` 包成主管的工具。这是 LangGraph 多 agent 编排最常见的一种——agent 作为工具，层级可以无限往下套（每个专员内部又可以挂自己的专员）。

## 项目结构

## 项目结构

```
src/
  agent.ts     Agent 编排：模型实例 + 工具注册（createAgent）
  tools.ts     自定义工具：calculator、current_time
  rag.ts       本地文档检索（RAG）：切分 + Embedding + 余弦相似度
  index.ts     流式 CLI 入口：streamEvents 监听并打印事件
  chat.ts      多轮对话入口：MemorySaver 检查点 + 固定 thread_id
  server.ts    HTTP 服务入口：POST /chat，SSE 流式返回
  team.ts      多 Agent 协作：主管 agent + 两个专员 agent（agent 作为工具）
  team-chat.ts 多 Agent 演示入口：派活 + 汇总的交互式对话
docs/          知识文档目录（RAG 数据源，.md / .txt）
```

## 原理简述

`agent.streamEvents()` 把 Agent 内部的每一步作为事件实时推出，核心事件：

- `on_chat_model_stream` — 模型 token 增量（打字机效果的来源）
- `on_tool_start` / `on_tool_end` — 工具调用与返回（`data.input` / `data.output`）

一次提问可能触发多轮「模型 → 工具 → 模型」循环；并行工具调用时用 `run_id` 配对调用与返回。