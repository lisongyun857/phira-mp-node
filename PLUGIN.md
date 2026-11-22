# AstrBot 插件开发说明（Phira 账号绑定）

本文是给 AstrBot 插件开发者的接口与流程说明。账号登录、密码校验、绑定关系全部由 **phira-mp-node 服务端**完成；插件只负责：

1. 接收 QQ 指令；
2. 调用服务端 HTTP API 生成登录链接 / 查询绑定 / 解绑；
3. 把链接或结果发回 QQ。

插件端**不要**收集或转发 Phira 密码，也不要自己保存密码、Phira token 或绑定关系。

## 1. 整体流程

```text
QQ 用户                     AstrBot 插件                     phira-mp-node
  |  /p登录                       |                                |
  |----------------------------->| GET /api/login/binding          |
  |                              |------------------------------->|
  |                              |<--- {bound:false} --------------|
  |                              | POST /api/login/link            |
  |                              |------------------------------->|
  |                              |<--- {link, expiresAt} ----------|
  |<---- 登录链接 ----------------|                                |
  |                                                               |
  |  浏览器打开链接 -> 输入 Phira 邮箱/密码 -> 服务端调用 Phira /login
  |                                                               |
  |  /p我的                       | GET /api/login/binding          |
  |----------------------------->|------------------------------->|
  |<---- Phira 昵称 / ID ---------|                                |
```

登录链接形如：

```text
https://phira.lisongyun.top/login/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

链接默认 10 分钟有效、绑定成功后立即失效，单个链接最多允许 5 次密码尝试。

## 2. 插件配置

建议在插件配置中提供：

```json
{
  "api_base": "http://127.0.0.1:3052",
  "api_token": "",
  "admin_ids": ["10001"]
}
```

- `api_base`：phira-mp-node 的 HTTP API 地址。AstrBot 与服务端同机时用 `127.0.0.1`。
- `api_token`：对应服务端 `server_config.yml` 的 `api.access_token`；留空表示不校验。
- `admin_ids`：管理指令（建房、删房、公告等）使用的 QQ 列表，与登录无关。

所有 API 请求都带：

```http
Authorization: Bearer <api_token>
Content-Type: application/json
```

## 3. 登录相关 API

统一响应格式：

```json
{ "ok": true, "data": {} }
```

```json
{ "ok": false, "error": "错误说明" }
```

### 3.1 生成登录链接

```http
POST /api/login/link
```

请求：

```json
{
  "platform": "qq",
  "userId": "123456789"
}
```

- `platform` 默认 `qq`，只允许字母、数字、`_`、`-`，1~20 位。
- `userId` 为平台用户 ID，1~64 位，建议直接传字符串。

成功：

```json
{
  "ok": true,
  "data": {
    "link": "https://phira.lisongyun.top/login/xxxxxxxx",
    "expiresAt": "2026-11-22T16:30:00.000Z"
  }
}
```

失败：

- `403`：服务端关闭了登录功能；
- `400`：`platform` 或 `userId` 不合法，或未配置 `login.public_url`。

### 3.2 查询绑定

```http
GET /api/login/binding?platform=qq&userId=123456789
```

已绑定：

```json
{
  "ok": true,
  "data": {
    "bound": true,
    "binding": {
      "platform": "qq",
      "userId": "123456789",
      "phiraId": 12345,
      "phiraName": "玩家昵称",
      "phiraAvatar": "https://...",
      "boundAt": "2026-11-22T16:20:00.000Z"
    }
  }
}
```

未绑定：

```json
{ "ok": true, "data": { "bound": false } }
```

### 3.3 解绑

```http
DELETE /api/login/binding
```

请求：

```json
{
  "platform": "qq",
  "userId": "123456789"
}
```

成功：

```json
{ "ok": true, "data": { "unbound": true } }
```

没有绑定时返回 `unbound: false`，不算错误。

## 4. 建议的 QQ 指令

| 指令 | 行为 |
| --- | --- |
| `/p登录` | 已绑定：显示 Phira 昵称/ID 和绑定时间；未绑定：生成链接并回复 |
| `/p我的` | 显示当前绑定信息；未绑定则提示先 `/p登录` |
| `/p解绑` | 建议先让用户回复“确认”再调用解绑 |
| 后续房间指令 | 服务端会增加；插件需要把 `platform` + `userId` 一起传给服务端 |

登录指令示例回复：

```text
请在 10 分钟内打开以下链接，使用 Phira 邮箱和密码登录：
https://phira.lisongyun.top/login/xxxxxxxx

链接只能绑定到你的 QQ，请勿转发。
```

已绑定示例：

```text
当前绑定：Phira 玩家昵称（ID 12345）
绑定时间：2026-11-22 16:20
如需更换账号，请先 /p解绑。
```

## 5. 绑定规则

- 一个 QQ 只能绑定一个 Phira 账号；重新登录会覆盖该 QQ 的旧绑定。
- 一个 Phira 账号只能绑定一个 QQ；如果已绑定其他 QQ，页面会提示先在原 QQ 解绑。
- 服务端只保存：`platform`、`userId`、`phiraId`、`phiraName`、`phiraAvatar`、`boundAt`。
- **不保存** Phira 密码、access token、refresh token。
- 绑定数据保存在服务端 `data/bindings.json`（已在 `.gitignore` 中忽略）。

## 6. 后续房间指令的权限模型

后续增加房间操作时，建议统一采用：

```json
{
  "platform": "qq",
  "userId": "123456789",
  "roomId": "room1",
  "action": "..."
}
```

服务端根据 `platform + userId` 查出绑定的 Phira 账号，再判断：

- 该 Phira 账号是否在目标房间；
- 是否是房主/管理员；
- 该操作是否允许。

插件端**不要**把 Phira ID 作为可伪造参数直接发给服务端；始终只发送 QQ 身份，由服务端解析绑定。

## 7. 插件端示例（Python / aiohttp）

```python
import aiohttp

class PhiraMpApi:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self.headers = {"Content-Type": "application/json"}
        if token:
            self.headers["Authorization"] = f"Bearer {token}"

    async def _request(self, method: str, path: str, body=None):
        async with aiohttp.ClientSession() as session:
            async with session.request(
                method,
                f"{self.base}{path}",
                headers=self.headers,
                json=body,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                return await resp.json()

    async def create_login_link(self, user_id: str):
        return await self._request(
            "POST",
            "/api/login/link",
            {"platform": "qq", "userId": str(user_id)},
        )

    async def get_binding(self, user_id: str):
        return await self._request(
            "GET",
            f"/api/login/binding?platform=qq&userId={user_id}",
        )

    async def unbind(self, user_id: str):
        return await self._request(
            "DELETE",
            "/api/login/binding",
            {"platform": "qq", "userId": str(user_id)},
        )
```

`/p登录` 处理逻辑：

```python
async def handle_login(event, api: PhiraMpApi):
    user_id = str(event.get_sender_id())
    binding = await api.get_binding(user_id)
    if not binding.get("ok"):
        await event.reply(f"服务端错误：{binding.get('error')}")
        return

    data = binding.get("data") or {}
    if data.get("bound"):
        b = data["binding"]
        await event.reply(
            f"当前绑定：{b['phiraName']}（ID {b['phiraId']}）\n"
            f"如需更换账号，请先 /p解绑。"
        )
        return

    created = await api.create_login_link(user_id)
    if not created.get("ok"):
        await event.reply(f"生成登录链接失败：{created.get('error')}")
        return

    await event.reply(
        "请在 10 分钟内打开以下链接，使用 Phira 邮箱和密码登录：\n"
        f"{created['data']['link']}\n\n"
        "链接只能绑定到你的 QQ，请勿转发。"
    )
```

## 8. 注意事项

- 不要在 QQ 里索要 Phira 密码；只发送服务端生成的链接。
- 不要在日志中记录完整登录链接或其中的 code。
- 链接是一次性凭据，群聊里发送时建议提醒用户不要转发。
- 服务端页面使用 HTTPS 由反向代理提供；插件只依赖 `api_base`，不需要关心页面部署。
- 插件的 API token 不要写进公开仓库；通过 AstrBot 配置或环境变量注入。

## 9. 联调检查表

- [ ] `/p登录` 能生成链接，域名和路径正确
- [ ] 链接页面能打开，显示的是当前 QQ（脱敏）
- [ ] 错误密码提示“邮箱或密码错误”
- [ ] 正确密码后显示绑定成功
- [ ] `/p我的` 能显示 Phira 昵称和 ID
- [ ] 同一 Phira 账号绑定第二个 QQ 会被拒绝
- [ ] `/p解绑` 后重新查询为未绑定
- [ ] 链接过期或尝试次数过多后失效
- [ ] 服务端重启后绑定仍然存在
