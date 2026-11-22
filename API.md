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
```

修改后需要重启服务器，`reload` 不会重新加载 API 配置。

启动成功时日志会输出：

```text
HTTP API listening on http://127.0.0.1:3052
```

## 认证

设置 `access_token` 后，所有请求都需要携带：

```http
Authorization: Bearer <access_token>
```

也接受直接把令牌作为 `Authorization` 的值。令牌为空时不校验（仅建议在本机使用）。

> API 令牌等同于管理员权限：可以查看隐藏房间、创建/删除房间、发送管理消息和公告。
> 管理员 QQ 的校验由 AstrBot 插件完成（`admin_ids`），API 本身不区分 QQ 身份。

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
| `memoryMB` | 进程 RSS 内存 |

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
| `/p状态` | 查看服务器状态 |
| `/p帮助` | 显示命令列表 |
| `/p创建房间 <房间ID>` | 创建房间（管理员） |
| `/p删除房间 <房间ID>` | 解散并删除房间（管理员） |
| `/p管理消息 <房间ID\|all> <内容>` | 向房间发送管理消息（管理员） |
| `/p公告 <内容>` | 向所有在线玩家发送公告（管理员） |

## 安全建议

- 同机部署时保持 `host: "127.0.0.1"`，不要暴露到公网。
- 跨机器部署时使用 `0.0.0.0`，同时设置强随机 `access_token`，并在防火墙/安全组中只放行 AstrBot 的 IP。
- 不要把 API 端口直接暴露给公网，除非已经配置了令牌和访问控制。
- 内置 `qq_bot` 与 AstrBot 插件会重复回复同一条指令，接入 AstrBot 后建议设置 `qq_bot.enabled: false`。

## 限制

- HTTP API 只提供查询与管理，不包含游戏协议通信。
- 删除房间后，客户端需要玩家手动离开房间（见上文说明）。
- 修改 `api` 配置后必须重启服务器。
