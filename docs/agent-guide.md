# langchain-agent 使用说明

本 Agent 内置三个工具：`calculator`（算术计算）、`current_time`（当前时间）、`retrieve_docs`（本地文档检索）。

## 三个入口

1. 单次提问（流式展示全过程）：`npm start -- "你的问题"`
2. 交互式多轮对话：`npm run chat`（输入 `exit` 或 `quit` 退出）
3. HTTP 服务：`npm run server`，接口为 `POST /chat`，SSE 流式返回；浏览器打开 `http://localhost:3000/` 是配套对话页面

## 记忆

多轮上下文由 SQLite 检查点落盘保存，文件在 `.data/memory.db`：

- `chat` 用固定线程 `default`，重启后接着聊
- HTTP 服务按 `sessionId` 分线程，同名会话共享上下文、重启不丢
- 清空记忆：删掉 `.data/memory.db`（多进程不要同时打开同一份 db）

## 配置

所需环境变量（`.env` 或系统环境变量二选一）：

- `AGENT_BASE_URL`：模型供应商接口地址
- `AGENT_MODEL`：对话模型名
- `AGENT_API_KEY`：API Key
- `AGENT_EMBEDDING_MODEL`（可选）：Embedding 模型名，用于本地文档检索，默认 `Xenova/bge-small-zh-v1.5`

## HTTP 接口协议

请求体：`{ "message": "你的问题", "sessionId": "会话id（可选）" }`

SSE 事件流（每行 `data: <json>`）：

- `{"type":"token","content":"..."}` 模型 token 增量
- `{"type":"tool","name":"...","data":...}` 工具调用
- `{"type":"tool_result","name":"...","data":...}` 工具返回
- `{"type":"done"}` 回答结束