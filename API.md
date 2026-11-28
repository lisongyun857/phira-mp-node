# phira-mp-node HTTP API

供 AstrBot 插件、管理面板、脚本等外部程序查询和管理 Phira 多人服务器。

API 与游戏服务器在同一个 Node 进程中运行，默认监听 `http://127.0.0.1:3052`。

## 启用

在 `server_config.yml` 中添加或修改：

```yaml
api:
  enabled: true
  # 同机运行填 127.0.0.1；AstrBot 在其它机器时改为 0.0.0.0
  host: "127.0.0.1"
  port: 3052
  # 对外暴露时务必设置一个足够随机的令牌
  access_token: "change-me"
  # 需要校验 token 的接口，默认全部公开
  # 每行一项，支持 "METHOD /path" 或 "/path"，* 为通配符
  protected_paths:
    - POST /api/announce
    - POST /api/rooms/*
    - /api/room/*
  # 优先级更高，即使命中 protected_paths 也允许匿名访问
  public_paths:
    - GET /api/status

login:
  enabled: true
  # 登录链接使用的公网地址；/login/ 需要反向代理到本 API
  public_url: "https://phira.lisongyun.top"
  link_ttl: 600
  max_attempts: 5
  bindings_file: "data/bindings.json"
```

修改后需要重启服务器，`reload` 不会重新加载 API 配置。

启动成功时日志会输出：

```text
HTTP API listening on http://127.0.0.1:3052
```

## 认证

默认**所有接口公开**，不校验令牌。只有同时满足以下条件的请求才需要携带令牌：

1. `api.access_token` 非空；
2. 请求匹配 `api.protected_paths` 中的某一项；
3. 没有匹配 `api.public_paths`（公开优先）。

路径规则：

| 写法 | 含义 |
| --- | --- |
| `/api/status` | 任意方法匹配该路径 |
| `GET /api/rooms` | 仅 GET 匹配 |
| `POST /api/rooms/*` | POST 且路径以 `/api/rooms/` 开头 |
| `/api/room/*` | 任意方法匹配 `/api/room/` 下的所有路径 |

携带令牌：

```http
Authorization: Bearer <access_token>
```

也接受直接把令牌作为 `Authorization` 的值。

> 默认公开是为了方便同机部署的 AstrBot 插件。只要 API 端口可能被其他机器访问，就应设置 `access_token` 并把敏感接口（公告、建房删房、房间控制、绑定管理）加入 `protected_paths`。

> API 令牌等同于管理员权限：可以查看隐藏房间、创建/删除房间、发送管理消息和公告。
> 管理员 QQ 的校验由 AstrBot 插件完成（`admin_ids`），API 本身不区分 QQ 身份。

## 反向代理与客户端 IP

经过 Nginx 等反向代理时，服务端会从 `X-Forwarded-For` / `X-Real-IP` 解析真实客户端 IP，用于日志中的登录尝试、令牌校验失败和接口错误。

只有请求来自 `api.trusted_proxies` 中的地址时才会采信代理头，默认是 `127.0.0.1` 和 `::1`（同机 Nginx）。代理在其他机器时，把代理的内网地址加入列表；设为 `[]` 表示完全忽略代理头。

```yaml
api:
  trusted_proxies:
    - 127.0.0.1
    - "::1"
    # - 10.0.0.2   代理在其他机器时加入
```

Nginx 建议配置：

```nginx
location /login/ {
    proxy_pass http://127.0.0.1:3052;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`X-Forwarded-For` 为链式列表时，服务端从右向左跳过受信任代理，取第一个非代理地址，客户端无法通过伪造头部绕过。

## 跨域（CORS）

网页管理面板部署在独立域名时，把前端地址加入 `api.allowed_origins`：

```yaml
api:
  allowed_origins:
    - "https://phira-web.example.com"
    - "https://admin.example.com"
```

`"*"` 表示允许任意来源（默认）。服务端会处理 `OPTIONS` 预检，并允许 `Authorization`、`Content-Type` 请求头。

## 网页登录会话

普通用户用 Phira 邮箱密码登录网页，服务端代理登录 Phira 并签发会话 token（有效期 7 天，内存存储，服务器重启后失效）。同一 IP 10 分钟内最多尝试 10 次。

### `POST /api/web/login`

```json
{ "email": "user@example.com", "password": "******" }
```

成功返回：

```json
{
  "ok": true,
  "data": {
    "token": "64 位十六进制字符串",
    "expiresAt": 1730000000000,
    "user": { "id": 10001, "name": "Alice", "avatar": null },
    "binding": { "platform": "qq", "userId": "123456789", "phiraId": 10001 }
  }
}
```

### `GET /api/web/me`

请求头 `Authorization: Bearer <token>`，返回当前用户、在线状态、QQ 绑定和所在房间详情：

```json
{
  "ok": true,
  "data": {
    "user": { "id": 10001, "name": "Alice", "avatar": null },
    "online": true,
    "binding": null,
    "room": { "id": "room1", "state": "SelectChart", "members": [] },
    "expiresAt": 1730000000000
  }
}
```

### `POST /api/web/logout`

请求头带会话 token，注销当前会话。

### `POST /api/web/unbind`

请求头带会话 token，解除该 Phira 账号当前的 QQ 绑定。

### 使用会话控制房间

`POST /api/room/action` 支持用 `sessionToken` 代替 `platform + userId`：

```json
{
  "sessionToken": "<web token>",
  "action": "lock",
  "locked": true
}
```

权限规则与 QQ 端一致：默认要求是房主；Phira 账号必须在线。

## 管理接口

管理接口默认需要管理员身份：先用管理员密码换取管理员会话（12 小时），请求头带 `Authorization: Bearer <token>`；也接受 `api.access_token`。两者都未配置时保持开放模式（兼容旧部署和 QQ 插件）。

### `POST /api/admin/login`

```json
{ "password": "管理员密码" }
```

成功返回 `{ "token": "...", "expiresAt": 1730000000000 }`。同一 IP 10 分钟内最多尝试 10 次。

密码来自 `server_config.yml` 的 `api.admin_password`，或在管理面板“系统设置”里修改（写入 `runtime-config.json`，重启后仍生效）。

### `POST /api/admin/logout`

注销当前管理员会话。

### 查询接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/users` | 在线用户列表 |
| `GET /api/bindings?search=&page=1&pageSize=20` | 绑定搜索与分页；不带 `page` 时返回全部 |
| `GET /api/logs?lines=200` | 最新日志末尾若干行（最多 1000 行） |
| `GET /api/room?id=room1` | 任意房间详情（公开，无需登录） |
| `GET /api/admin/config` | 当前生效的 API 配置（敏感项只返回是否已配置） |
| `GET /api/admin/bans` | 当前封禁列表 |

### 操作接口

| 接口 | 请求体 |
| --- | --- |
| `POST /api/admin/config` | `{ adminPassword?, accessToken?, allowedOrigins? }` |
| `POST /api/admin/ban` | `{ type: "ip"\|"user", value, minutes, reason? }`（minutes=0 永久） |
| `DELETE /api/admin/ban` | `{ type, value }` |
| `POST /api/admin/kick` | `{ id }` |
| `POST /api/admin/bindings/unbind` | `{ keys: [{ platform, userId }] }` |
| `POST /api/room-creation` | `{ enabled }` |
| `POST /api/rooms/create` | `{ id }` |
| `POST /api/rooms/delete` | `{ id }` |
| `POST /api/say` | `{ target, content }` |
| `POST /api/announce` | `{ content }` |
| `POST /api/login/link` | `{ platform, userId }` |
| `DELETE /api/login/binding` | `{ platform, userId }` |

### 实时日志（SSE）

`GET /api/logs/stream?token=<管理员会话或 access_token>`

返回 `text/event-stream`，每条日志为 `event: log`，`data` 是 JSON 字符串。由于浏览器 `EventSource` 不能设置请求头，token 通过查询参数传递；最多 10 个并发连接。

### 管理员房间操作

`POST /api/room/action` 传 `"admin": true` 和 `roomId`，请求头带管理员会话或 `access_token`，不需要玩家身份即可锁定/轮换/踢人/转让/解散。

### 封禁说明

封禁保存在内存中，服务器重启后失效。IP 封禁同时拦截 HTTP API 和游戏 TCP 连接；Phira ID 封禁在游戏鉴权时拒绝。

> 注意：配置 `admin_password` 后，QQ 插件调用管理类接口必须配置相同的 `api_token`（或把 `api.access_token` 留空并自行承担公开风险），否则会返回 401。

## 公开登录页面

以下两个路径**不需要** API 令牌，供 QQ 用户打开浏览器完成 Phira 账号绑定：

- `GET /login/<code>`：登录表单
- `POST /login/<code>`：提交 Phira 邮箱和密码

它们由反向代理暴露在 `login.public_url` 下，例如把 `https://phira.lisongyun.top/login/` 转发到 `http://127.0.0.1:3052/login/`。`<code>` 是由 `/api/login/link` 生成的一次性登录码，默认 10 分钟有效。

密码只用于向 Phira 官方 `/login` 验证，不会写入日志或绑定文件；Phira token 在读取完用户信息后丢弃。绑定只保存 Phira ID、昵称、头像和绑定时间。

## 响应格式

成功：

```json
{
  "ok": true,
  "data": {}
}
```

失败：

```json
{
  "ok": false,
  "error": "错误说明"
}
```

| HTTP 状态 | 含义 |
| --- | --- |
| `200` | 成功 |
| `400` | 请求体缺失、JSON 非法、房间 ID 不合法 |
| `401` | 令牌缺失或错误 |
| `404` | 路径或房间不存在 |
| `409` | 房间 ID 已存在 |

请求体必须是 JSON，最大 64 KB。

## 端点

### `GET /api/status`

服务器状态。

```json
{
  "ok": true,
  "data": {
    "uptime": 3600,
    "users": 3,
    "sessions": 3,
    "rooms": 2,
    "allowClientCreateRoom": true,
    "memoryMB": 48
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `uptime` | 进程运行秒数 |
| `users` | 服务器上的用户数（包含掉线等待重连） |
| `sessions` | 当前 TCP 连接数 |
| `rooms` | 房间数（含隐藏房间） |
| `allowClientCreateRoom` | 是否允许玩家在客户端创建房间 |
| `memoryMB` | 进程 RSS 内存 |

### `POST /api/room-creation`

允许或禁止玩家在客户端创建房间。控制台、QQ 指令和本 API 建房不受影响。

```json
{ "enabled": false }
```

成功返回：

```json
{
  "ok": true,
  "data": { "enabled": false }
}
```

`enabled` 必须是布尔值。该开关是运行时状态，重启后恢复为 `server_config.yml` 中的 `allow_client_create_room`。

### `POST /api/login/link`

为 QQ 用户生成一次性 Phira 登录链接。

```json
{
  "platform": "qq",
  "userId": "123456789"
}
```

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

`platform` 省略时默认为 `qq`。该接口只生成链接，不检查是否已绑定；插件可以先调用绑定查询接口。

### `GET /api/login/binding?platform=qq&userId=123456789`

查询绑定。

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

未绑定：`{ "ok": true, "data": { "bound": false } }`

### `DELETE /api/login/binding`

解除绑定。

```json
{
  "platform": "qq",
  "userId": "123456789"
}
```

返回 `{ "ok": true, "data": { "unbound": true } }`；没有绑定时 `unbound` 为 `false`。

绑定规则：一个 QQ 只能绑定一个 Phira 账号，一个 Phira 账号也只能绑定一个 QQ。重复登录会覆盖该 QQ 的旧绑定；如果 Phira 账号已属于其他 QQ，页面会拒绝并提示先解绑。

### `GET /api/rooms`

在线房间列表。默认不包含 `_` 开头的隐藏房间。

查询参数：

| 参数 | 说明 |
| --- | --- |
| `all=1` 或 `all=true` | 包含隐藏房间 |

```json
{
  "ok": true,
  "data": {
    "rooms": [
      {
        "id": "room1",
        "hidden": false,
        "users": 2,
        "monitors": 0,
        "maxUsers": 8,
        "chart": { "id": 12345, "name": "Example Chart" },
        "locked": false,
        "live": false,
        "host": { "id": 10001, "name": "Player" },
        "state": "SelectChart"
      }
    ]
  }
}
```

房间字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 房间 ID |
| `hidden` | 是否隐藏房间（ID 以 `_` 开头） |
| `users` | 玩家人数 |
| `monitors` | 旁观人数 |
| `maxUsers` | 玩家人数上限（8） |
| `chart` | 当前谱面 `{id, name}`，未选谱时为 `null` |
| `locked` | 是否锁房 |
| `live` | 是否开启旁观直播 |
| `host` | 房主 `{id, name}`，空房时为 `null` |
| `state` | `SelectChart` / `WaitForReady` / `Playing` |

### `POST /api/rooms/create`

创建房间。第一个加入的玩家会自动成为房主。

```json
{ "id": "room1" }
```

成功返回：

```json
{
  "ok": true,
  "data": {
    "room": {
      "id": "room1",
      "hidden": false,
      "users": 0,
      "monitors": 0,
      "maxUsers": 8,
      "chart": null,
      "locked": false,
      "live": false,
      "host": null,
      "state": "SelectChart"
    }
  }
}
```

房间 ID 只能包含字母、数字、`-`、`_`，长度 1~20；已存在时返回 `409`。

### `POST /api/rooms/delete`

解散并删除房间。会向房内所有人发送“房间已被管理员解散”，并解除他们的房间绑定。

```json
{ "id": "room1" }
```

成功返回：

```json
{
  "ok": true,
  "data": { "id": "room1", "members": 4 }
}
```

> Phira 协议没有“服务器强制踢出房间”的命令，被解散的玩家需要自行点击离开。
> 服务端已兼容：不在房间时 `LeaveRoom` 也会返回成功。

### `POST /api/room/action`

通过 QQ 绑定关系控制房间。服务端根据 `platform + userId` 查出绑定的 Phira 账号，再校验该账号是否在线、是否在房间内、是否为房主。

公共请求字段：

| 字段 | 说明 |
| --- | --- |
| `platform` | 平台，默认 `qq` |
| `userId` | 平台用户 ID |
| `action` | 操作名，见下表 |
| `roomId` | 可选。管理员操作不在自己所在的房间时必填 |
| `admin` | 可选布尔。管理员 QQ 传 `true` 后可操作任意房间 |

| action | 额外字段 | 权限 | 说明 |
| --- | --- | --- | --- |
| `info` | — | 房内成员 / 管理员 | 房间详情与成员列表 |
| `lock` | `locked: true/false` | 房主 / 管理员 | 锁定或解锁房间 |
| `cycle` | `enabled: true/false` | 房主 / 管理员 | 切换轮换模式 |
| `select-chart` | `chartId: 12345` | 房主（需在房内） | 选择谱面 |
| `start` | — | 房主（需在房内） | 开始游戏并进入准备阶段 |
| `ready` | — | 房内成员 | 准备 |
| `cancel-ready` | — | 房内成员 | 取消准备；房主取消会撤销本局 |
| `abort` | — | 房内成员 | 中止当前游戏 |
| `kick` | `targetId` 或 `targetName` | 房主 / 管理员 | 踢出玩家或旁观者 |
| `set-host` | `targetId` 或 `targetName` | 房主 / 管理员 | 转让房主（目标必须是玩家） |
| `dissolve` | — | 房主 / 管理员 | 解散房间并解除所有成员绑定 |

示例：

```json
{
  "platform": "qq",
  "userId": "123456789",
  "action": "lock",
  "locked": true
}
```

成功返回：

```json
{ "ok": true, "data": { "id": "room1", "locked": true } }
```

`info` 返回房间详情：

```json
{
  "ok": true,
  "data": {
    "room": {
      "id": "room1",
      "state": "WaitForReady",
      "stateName": "准备中",
      "host": { "id": 10001, "name": "Alice" },
      "chart": { "id": 12345, "name": "Example Chart" },
      "locked": false,
      "cycle": false,
      "live": true,
      "users": 2,
      "monitors": 1,
      "maxUsers": 8,
      "isHost": true,
      "members": [
        { "id": 10001, "name": "Alice", "monitor": false, "online": true },
        { "id": 10002, "name": "Bob", "monitor": false, "online": true },
        { "id": 10003, "name": "Carol", "monitor": true, "online": true }
      ]
    }
  }
}
```

失败状态码：

- `403`：未绑定 QQ、Phira 账号不在线、不是房主、或不在目标房间；
- `404`：房间 / 目标玩家不存在；
- `409`：当前阶段不允许该操作（如未选谱就点开始）。

> `kick` 与 `dissolve` 会广播 `LeaveRoom` 并解除服务端的房间绑定；受 Phira 协议限制，被移出的客户端可能仍停留在房间界面，直到自己离开或重连。

### `POST /api/say`

向指定房间或所有房间发送管理消息，消息会带 `【管理】` 前缀。

```json
{
  "target": "room1",
  "content": "请准备"
}
```

`target` 为 `"all"` 时广播到所有房间（含隐藏房间）。

成功返回：

```json
{
  "ok": true,
  "data": { "target": "room1", "rooms": 1 }
}
```

### `POST /api/announce`

向所有在线玩家发送公告，消息会带 `【公告】` 前缀。

```json
{ "content": "服务器将在 10 分钟后维护" }
```

成功返回：

```json
{
  "ok": true,
  "data": { "users": 12 }
}
```

## 示例

### curl

```bash
export PHIRA_API="http://127.0.0.1:3052"
export PHIRA_TOKEN="change-me"

curl -s -H "Authorization: Bearer $PHIRA_TOKEN" \
  "$PHIRA_API/api/rooms"

curl -s -X POST -H "Authorization: Bearer $PHIRA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"room1"}' \
  "$PHIRA_API/api/rooms/create"

curl -s -X POST -H "Authorization: Bearer $PHIRA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target":"all","content":"欢迎"}' \
  "$PHIRA_API/api/say"
```

### Python / AstrBot

账号绑定与后续房间指令的插件开发说明见 [PLUGIN.md](PLUGIN.md)。

```python
import aiohttp

BASE = "http://127.0.0.1:3052"
TOKEN = "change-me"


async def phira_api(method: str, path: str, payload: dict | None = None) -> dict:
    headers = {"Authorization": f"Bearer {TOKEN}"}
    timeout = aiohttp.ClientTimeout(total=5)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.request(
            method, f"{BASE}{path}", json=payload, headers=headers
        ) as response:
            return await response.json()


async def list_rooms(include_hidden: bool = False) -> list[dict]:
    path = "/api/rooms?all=1" if include_hidden else "/api/rooms"
    data = await phira_api("GET", path)
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "API 请求失败"))
    return data["data"]["rooms"]


async def create_room(room_id: str) -> dict:
    data = await phira_api("POST", "/api/rooms/create", {"id": room_id})
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "创建房间失败"))
    return data["data"]["room"]
```

在 AstrBot 插件中注册指令：

```python
from astrbot.api.event import filter, AstrMessageEvent


@filter.command("p房间")
async def p_rooms(self, event: AstrMessageEvent):
    rooms = await list_rooms()
    if not rooms:
        yield event.plain_result("当前没有在线房间")
        return

    lines = [f"在线房间（{len(rooms)}）："]
    for index, room in enumerate(rooms, 1):
        chart = (room.get("chart") or {}).get("name") or "未选谱"
        lines.append(
            f"{index}. {room['id']} · {room['users']}/{room['maxUsers']} 人 · {chart}"
        )
    yield event.plain_result("\n".join(lines))
```

完整的 `/p` 指令实现见配套插件 `astrbot_plugin_phira_mp`：

| 指令 | 说明 |
| --- | --- |
| `/p房间` | 查看在线房间 |
| `/p房间 全部` | 查看全部房间（含隐藏，管理员） |
| `/p房间信息` | 查看自己所在房间的成员与状态（绑定） |
| `/p锁定` / `/p解锁` | 锁定/解锁自己的房间（房主） |
| `/p轮换 开\|关` | 切换轮换模式（房主） |
| `/p选谱 <谱面ID>` | 选择谱面（房主） |
| `/p开始` | 开始游戏（房主） |
| `/p准备` / `/p取消准备` | 准备 / 取消准备（房内成员） |
| `/p中止` | 中止当前游戏（房内成员） |
| `/p踢人 <玩家ID或昵称>` | 踢出成员（房主） |
| `/p转让房主 <玩家ID或昵称>` | 转让房主（房主） |
| `/p解散 [房间ID]` | 解散房间（房主 / 管理员） |
| `/p状态` | 查看服务器状态 |
| `/p帮助` | 显示命令列表 |
| `/p创建房间 <房间ID>` | 创建房间（管理员） |
| `/p删除房间 <房间ID>` | 解散并删除房间（管理员） |
| `/p管理消息 <房间ID\|all> <内容>` | 向房间发送管理消息（管理员） |
| `/p建房开关 开\|关` | 禁止/允许玩家在客户端创建房间（管理员） |
| `/p公告 <内容>` | 向所有在线玩家发送公告（管理员） |

## 安全建议

- 同机部署时保持 `host: "127.0.0.1"`，不要暴露到公网。
- 跨机器部署时使用 `0.0.0.0`，同时设置强随机 `access_token`，并把需要保护的接口写入 `api.protected_paths`（默认全部公开）；在防火墙/安全组中只放行 AstrBot 的 IP。
- `POST /api/room/action` 的 `admin` 字段由插件根据管理员 QQ 传入；如果 API 对公网暴露，必须用 `protected_paths` + 令牌保护该接口，否则任何人都能伪造管理员操作。
- 不要把 API 端口直接暴露给公网，除非已经配置了令牌和访问控制。
- 内置 `qq_bot` 与 AstrBot 插件会重复回复同一条指令，接入 AstrBot 后建议设置 `qq_bot.enabled: false`。

## 限制

- HTTP API 不包含游戏协议通信，但可以通过 `/api/room/action` 以房主身份改变房间状态。
- 删除/踢出后，客户端需要玩家手动离开房间（见上文说明）。
- 修改 `api` 配置后必须重启服务器。
