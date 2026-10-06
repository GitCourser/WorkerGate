# WorkerGate

基于 Cloudflare Workers 免费计划的 OpenAI 兼容接口聚合网关。

## 功能特性

- **静态模型列表**：无需向上游查询模型，直接读取 Workers 环境变量 `MODELS` 并以标准 OpenAI 格式响应 `/v1/models`。
- **密钥安全隔离**：下游客户端鉴权密钥与上游提供商配置均存储在 Cloudflare Workers Secrets 中。
- **动态模型映射**：支持在上游配置中定义模型映射表，请求转发前自动重写请求体中的实际模型名。
- **会话粘性路由**：支持双级缓存机制（L1 内存 Map + L2 Cloudflare KV），同会话固定路由到同一上游，默认 TTL 为 12 小时。
- **智能选号调度**：新会话通过并发请求各上游选号接口 `GET /v1/account/select?model={model_id}`（带 15 秒超时熔断），自动选取最先过期的有效账号，并在转发时附加 `x-account-id` 请求头。
- **原生零依赖**：采用原生 Fetch API 构建，体积轻量（打包后仅约 15KB），完美适配 Cloudflare Workers 免费配额与 CPU 时间限制。
- **流式透传与跨域支持**：完整支持 SSE（Server-Sent Events）流式响应与 CORS 预检请求。

---

## 环境变量与 Secrets 说明

### 1. 环境变量（`wrangler.toml` 中的 `[vars]`）

| 变量名 | 类型 | 说明 | 示例 |
| :--- | :--- | :--- | :--- |
| `MODELS` | string | 允许向客户端暴露的模型列表，英文逗号分隔 | `deepseek-v4.1-flash,gpt-4o,claude-3-5-sonnet` |

### 2. KV 绑定（`wrangler.toml` 中的 `[[kv_namespaces]]`）

| 绑定名 | 说明 |
| :--- | :--- |
| `SESSION_KV` | 存储会话 ID 与所选上游及账号 ID 的绑定关系（TTL 12 小时） |

### 3. Workers Secrets（通过 `wrangler secret put` 注入）

#### `CLIENT_KEYS`
下游客户端鉴权密钥，支持英文逗号分隔的多 Key 格式：
```bash
npx wrangler secret put CLIENT_KEYS
# 输入: sk-client-user1,sk-client-user2
```

#### `PROVIDERS`
上游提供商配置的 JSON 对象字典：
```bash
npx wrangler secret put PROVIDERS
```

JSON 格式规范示例：
```json
{
  "provider_a": {
    "url": "https://api.provider-a.com/v1",
    "key": "sk-upstream-a"
  },
  "provider_b": {
    "url": "https://api.provider-b.com/v1",
    "key": "sk-upstream-b",
    "models": {
      "deepseek-v4.1-flash": "deepseek-flash"
    }
  }
}
```

字段说明：
- `url`：上游接口基础地址（支持带或不带 `/v1`，网关会自动智能适配路径拼接）。
- `key`：向该上游请求时使用的 Bearer Token。
- `models`（可选）：模型映射字典，键为下游请求的模型名，值为转发给该上游时实际替换的模型名。

---

## 快速部署流程

### 第一步：安装依赖

```bash
npm install
```

### 第二步：创建 KV 命名空间

在 Cloudflare 账户中创建 KV 命名空间：

```bash
npx wrangler kv namespace create SESSION_KV
```

执行后将输出类似如下的信息：
```text
[[kv_namespaces]]
binding = "SESSION_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

将生成的 `id` 填入 `wrangler.toml` 文件的 `[[kv_namespaces]]` 节点中。

### 第三步：配置 Secrets

分别设置客户端鉴权密钥与上游提供商配置：

```bash
npx wrangler secret put CLIENT_KEYS
npx wrangler secret put PROVIDERS
```

### 第四步：部署上线

```bash
npx wrangler deploy
```

---

## 请求处理与会话调度逻辑

1. **鉴权校验**：检查请求头中的 `Authorization: Bearer <key>` 是否存在于 `CLIENT_KEYS` 中，未通过则返回标准 401 错误。
2. **模型查询**：若请求为 `GET /v1/models`，直接返回 `MODELS` 中配置的模型列表。
3. **会话提取**：
   - 优先检查请求头 `session-id`；
   - 其次查找任意以 `-session-id` 结尾的请求头（如 `x-session-id`、`client-session-id` 等）；
   - 若不存在任何会话头，判定为单次请求，执行选号调度后直接转发，不落库 KV 以节省免费版配额。
4. **会话匹配与缓存层级**：
   - 若提取到会话 ID，先查询 Workers 内存 Map（带 12 小时时间戳失效校验）；
   - 内存未命中则查询 Cloudflare KV 命名空间；
   - KV 命中后回填内存 Map，直接使用绑定的上游提供商与 `account_id`。
5. **新会话选号调度**：
   - 当会话在缓存中均未命中时，提取请求体中的 `model` 字段；
   - 向所有配置的上游并行发起 `GET /v1/account/select?model={model_id}`（超时时间为 15 秒）；
   - 上游响应格式要求：`{ "account_id": 3, "expire_at": 1767225600 }`；
   - 选出 `expire_at` 最早（最先过期）的上游；
   - 将绑定关系写入内存 Map 与 KV（TTL 为 12 小时）。
6. **请求转发与重写**：
   - 替换请求头 `Authorization` 为选中上游的 `key`；
   - 注入请求头 `x-account-id`，值为选号得到的账号 ID；
   - 保留客户端原始请求头（包括会话头）；
   - 若存在模型映射，自动将请求体中的 `model` 改写为上游映射的目标模型名；
   - 流式响应（SSE）与状态码直接透传至下游客户端。

---

## 客户端调用示例

### 1. 查询模型列表

```bash
curl https://<your-worker>.workers.dev/v1/models \
  -H "Authorization: Bearer sk-client-user1"
```

### 2. 发起对话请求（携带会话 ID）

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-client-user1" \
  -H "session-id: sess_123456789" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "messages": [
      {
        "role": "user",
        "content": "Hello!"
      }
    ],
    "stream": true
  }'
```
