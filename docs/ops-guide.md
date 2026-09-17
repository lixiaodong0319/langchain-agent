# 部署与运维说明

## 启动 HTTP 服务

```bash
npm run server
```

服务默认监听 3000 端口，可用 `PORT` 环境变量覆盖（例如 Windows 下 `setx PORT 8080` 或将 `PORT=8080` 写入 `.env`）。

## 健康自检

启动成功后终端会打印 `HTTP 服务已启动：http://localhost:3000`，即可用 curl 发起请求验证：

```bash
curl -N -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"现在几点了？"}'
```

## 常见问题

- **端口被占用**：Windows 下先停掉旧进程再启动，避免 `EADDRINUSE` 报错。
- **API 调用失败**：检查 `.env` 中的 `AGENT_BASE_URL`、`AGENT_MODEL`、`AGENT_API_KEY` 是否与供应商文档一致。
- **跨域失败**：服务已默认开启 CORS（开发用，全来源放行）；生产环境需收敛 `Access-Control-Allow-Origin`。