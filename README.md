# phira-mp-node

Phira 多人游戏服务器的 Node.js 重写版，二进制协议与 [TeamFlos/phira-mp](https://github.com/TeamFlos/phira-mp) 保持兼容。在官方功能之外，额外提供公告与在线房间展示、隐藏房间、交互式控制台以及 NapCat QQ 机器人。

> 非官方项目，与 TeamFlos 无关联。

## 功能

- 与 Phira 客户端兼容的 TCP 二进制协议（默认端口 `12346`）
- 房间创建/加入/离开、旁观（monitor）、选谱、准备、开始、成绩上传、中止、锁房、房主轮换
- 使用官方 API 鉴权（`/me`）、掉线保留 10 秒等待重连
- 玩家连接时展示服务器公告与在线房间列表
- 隐藏房间：房间 ID 以 `_` 开头时不出现在公开房间列表（仍可凭完整 ID 加入）
- 客户端建房开关：控制台、QQ、API 可禁止玩家自行建房，管理员指令建房不受影响
- 在线房间列表显示游戏阶段（未开始 / 准备中 / 游戏中）
- 交互式命令行控制台
- NapCat QQ 机器人（OneBot 11 反向 WebSocket）：房间查询、管理员建房/删房、管理消息、公告、定时房间推送
- HTTP 管理 API：供 AstrBot 等外部程序查询和管理服务器
- 按小时写入 `log/` 的日志（含聊天记录）

## 环境要求

- Node.js >= 18（使用内置 `fetch`；推荐 20 或更高）
- 服务器可以访问 `https://phira.5wyxi.com`

## 安装与启动

```bash
git clone https://github.com/lisongyun857/phira-mp-node.git
cd phira-mp-node
npm install
npm start
```

或指定端口：

```bash
node src/index.js --port 12346
```

启动后若在终端中运行，会进入控制台（提示符 `phira-mp> `）。

## 配置

配置位于根目录 `server_config.yml`：

```yaml
monitors:
  - 2

announcements:
  - "欢迎来到 Phira 多人服务器"
  - "房间名以 _ 开头时不会出现在在线房间列表中"

show_online_rooms: true
allow_client_create_room: true

api:
  enabled: true
  host: "127.0.0.1"
  port: 3052
  access_token: ""

qq_bot:
  enabled: true
  port: 3001
  access_token: ""
  admin_qq:
    - 10001
  group_ids:
    - 123456
  report_interval: 300
```

| 配置项 | 说明 |
| --- | --- |
| `monitors` | 允许旁观（monitor）的 Phira 用户 ID |
| `announcements` | 玩家连接服务器时展示的公告，每条一行 |
| `show_online_rooms` | 连接时是否展示在线房间列表 |
| `allow_client_create_room` | 是否允许玩家在客户端创建房间；控制台、QQ、API 指令建房不受影响 |

> `allow_client_create_room` 是启动时的默认值；通过控制台 `roomlock`、QQ `#建房开关` 或 API 修改只在运行时生效，重启后恢复配置值。
| `api.enabled` | 是否启用 HTTP 管理 API |
| `api.host` | API 监听地址，默认仅本机；跨机器访问时改为 `0.0.0.0` |
| `api.port` | API 监听端口 |
| `api.access_token` | API 访问令牌；对外暴露时务必设置 |
| `qq_bot.enabled` | 是否启用 QQ 机器人 |
| `qq_bot.port` | 机器人 WebSocket 监听端口 |
| `qq_bot.access_token` | 与 NapCat 的 token 一致；留空不校验 |
| `qq_bot.admin_qq` | 允许建房/删房/管理消息/公告的 QQ 号 |
| `qq_bot.group_ids` | 定时推送在线房间的群号 |
| `qq_bot.report_interval` | 定时推送间隔（秒），`0` 关闭 |

修改后可在控制台执行 `reload` 重新加载游戏侧配置；QQ 机器人和 HTTP API 的配置在启动时读取，需要重启服务器生效。

> 请把示例中的 `admin_qq`、`group_ids` 换成自己的 QQ 号和群号。

## 控制台命令

| 命令 | 说明 |
| --- | --- |
| `help` | 显示帮助 |
| `status` | 运行时间、在线用户、连接数、房间数、内存 |
| `rooms` | 列出所有房间（含隐藏房间） |
| `create <房间ID>` | 创建房间，第一个加入的玩家成为房主 |
| `roomlock on\|off` | 禁止/允许玩家在客户端创建房间（指令建房不受影响） |
| `say <房间ID\|all> <内容>` | 向房间发送管理消息 |
| `announce <内容>` | 向所有在线玩家发送公告 |
| `reload` | 重新加载 `server_config.yml` |
| `stop` | 关闭服务器 |

## NapCat 接入

1. 在 NapCat 的「网络配置」中新建 **WebSocket 客户端**。
2. 地址填写 `ws://<服务器地址>:3001`。
3. Access Token 与 `qq_bot.access_token` 保持一致。
4. 消息格式选择 `string` 或 `array` 均可。

机器人只处理 `post_type = message` 的事件，会忽略自己发送的消息。

## QQ 命令

所有命令以 `#` 开头。

所有人：

| 命令 | 说明 |
| --- | --- |
| `#房间` | 查看在线房间 |
| `#状态` | 查看服务器状态 |
| `#帮助` | 查看命令列表 |

仅 `admin_qq` 中的 QQ：

| 命令 | 说明 |
| --- | --- |
| `#房间 全部` | 查看全部房间（含隐藏房间） |
| `#创建房间 <房间ID>` | 创建房间，第一个加入的玩家成为房主 |
| `#删除房间 <房间ID>` | 解散并删除房间（别名 `#解散房间`） |
| `#管理消息 <房间ID\|all> <内容>` | 向房间发送管理消息 |
| `#建房开关 开\|关` | 禁止/允许玩家在客户端创建房间 |
| `#公告 <内容>` | 向所有在线玩家发送公告 |

`group_ids` 中的群会按 `report_interval` 定时收到在线房间推送（没有公开房间时跳过）。

## AstrBot 接入（/p 指令）

phiraserver 通过 HTTP API 对外提供数据和管理能力，配套的 AstrBot 插件为 `astrbot_plugin_phira_mp`，将插件目录放入 AstrBot 的 `data/plugins/` 后重载即可。

1. 在 `server_config.yml` 中启用 `api`，对外暴露时设置 `access_token`。
2. 若 AstrBot 与服务器不在同一台机器，将 `api.host` 改为 `0.0.0.0`。
3. 在 AstrBot 插件配置中填写 `api_base`、`api_token` 和管理员 QQ `admin_ids`。
4. 同时启用内置 `qq_bot` 会导致两个机器人重复回复，建议将 `qq_bot.enabled` 设为 `false`。

指令同时支持 `/p房间` 和 `/p 房间` 两种写法：

| 指令 | 说明 |
| --- | --- |
| `/p房间` | 查看在线房间 |
| `/p房间 全部` | 查看全部房间（含隐藏，管理员） |
| `/p状态` | 查看服务器状态 |
| `/p帮助` | 显示命令列表 |
| `/p创建房间 <房间ID>` | 创建房间（管理员） |
| `/p删除房间 <房间ID>` | 解散并删除房间（管理员） |
| `/p管理消息 <房间ID\|all> <内容>` | 向房间发送管理消息（管理员） |
| `/p建房开关 开\|关` | 禁止/允许玩家在客户端创建房间（管理员） |
| `/p公告 <内容>` | 向所有在线玩家发送公告（管理员） |

HTTP API 默认监听 `http://127.0.0.1:3052`，完整的认证方式、端点、响应格式和 AstrBot 开发示例见 [API.md](API.md)。

## 文档

- [API.md](API.md)：HTTP API 认证、端点、响应格式与 AstrBot 插件开发示例

## 目录结构

```
src/
  index.js            入口：TCP 监听、控制台、QQ 机器人
  server.js           服务器状态（连接/用户/房间）
  session.js          协议会话、鉴权、命令处理
  room.js             房间与游戏状态机
  user.js             用户、掉线等待
  lobby.js            公告与在线房间文案
  console.js          命令行控制台
  bot.js              NapCat / OneBot 11 WebSocket 机器人
  api.js              HTTP 管理 API（供 AstrBot 接入）
  config.js           server_config.yml 读取
  logger.js           控制台与文件日志
  l10n.js             多语言错误文案
  protocol/
    binary.js         二进制读写（小端、ULEB128）
    models.js         协议命令与结构定义
locales/              en-US / zh-CN / zh-TW
```

## 已知限制

- Phira 协议没有“服务器强制踢出房间”的命令。删除房间后，玩家需要自行点击离开；`LeaveRoom` 已做兼容（不在房间时也返回成功），可以正常退出。
- 连接时展示的公告和房间列表以聊天气泡呈现，此时玩家尚未进入房间，发送者会显示为 `?`，这是客户端限制。
- 选谱需要谱面存在于官方 API 中；本地导入且带有无效 ID 的谱面会提示 `chart <id> unavailable on Phira (HTTP 404)`。
- 谱面信息、成绩上传依赖 `https://phira.5wyxi.com`，无法访问时相关功能不可用。

## License

[Apache-2.0](LICENSE)。协议与参考行为来自 [TeamFlos/phira-mp](https://github.com/TeamFlos/phira-mp)，详见 [NOTICE](NOTICE)。
