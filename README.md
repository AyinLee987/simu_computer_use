# Agent Lab · 网页代理实验室

一个可以在本机启动的真实 AI 浏览器操作 demo：输入目标，观察模型读取截图、选择鼠标键盘动作，再根据执行结果继续操作。浏览器运行在 Docker 桌面中，控制台同时提供实时桌面和模型观察截图。

这是对“截图 → 模型决策 → 桌面输入 → 再截图”架构的独立演示，不是 Codex 官方电脑控制插件，也不代表其内部实现。

## 启动并打开控制台

先准备好以下环境：

- Docker Desktop 已启动，Docker 引擎可用，并使用 Linux 容器。
- Node.js 22 或更新版本，以及随附的 npm。
- 任选一种模型来源：已安装并登录的 Codex CLI，或一个支持图片输入与 JSON 输出的 OpenAI / 兼容 API 服务。

在此项目目录打开终端，依次运行：

```powershell
npm install
npm run setup
# 如需 API 模式，在此时编辑生成的 .env，再继续启动。
npm run desktop
npm start
```

保持最后一个终端运行，然后打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。控制台会显示当前模型来源、对应的计费提示与 Docker 桌面状态；模型配置和桌面就绪后可以开始任务。首次执行 `npm run desktop` 会构建容器并下载浏览器等依赖。

Windows 也可以在准备好上述环境后，双击 `start-demo.cmd`。启动脚本会处理依赖、生成本机控制凭据、启动容器和控制台服务；引擎未运行时，会尝试启动 Docker Desktop。如果当前 Docker 版本不支持自动启动，请先手动打开 Docker Desktop。

`npm run setup` 会生成本机 `.env`，并创建保存随机容器控制令牌的 `dockercompose.env`；已有文件均不覆盖。容器控制令牌用于宿主调用桌面服务，不是模型 API key。可提交到仓库的 `.env.example` 只包含配置模板，真实 `.env`、容器令牌和 `runs/` 产物不纳入版本控制。

## 配置模型来源

在项目根目录的 `.env` 中配置模型。默认 `MODEL_PROVIDER=auto`：填写了 `OPENAI_API_KEY` 就使用 API；没有 key 就使用本机 Codex 登录。也可以明确设置 `codex` 或 `openai`。这里的 `openai` 表示 API 连接方式，也可连接显式配置的兼容服务。

以下是完整配置示例，API key 留空，按你的选择填写：

```dotenv
MODEL_PROVIDER=auto
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1
OPENAI_API_STYLE=responses
OPENAI_RESPONSE_FORMAT=json_schema
OPENAI_TIMEOUT_MS=150000
CODEX_MODEL=
```

| 配置 | 用途 |
| --- | --- |
| `MODEL_PROVIDER` | `auto`、`codex` 或 `openai`；默认 `auto` |
| `OPENAI_API_KEY` | API 模式需要的密钥；Codex 登录模式可留空 |
| `OPENAI_BASE_URL` | API 根地址，默认 `https://api.openai.com/v1`；通常包含 `/v1`，不包含 `/responses`、`/chat/completions`、查询参数或片段；远端服务必须使用 HTTPS |
| `OPENAI_MODEL` | API 模型名称，示例为 `gpt-4.1`；必须支持图片输入与所选 JSON 输出方式 |
| `OPENAI_API_STYLE` | `responses` 或 `chat_completions`；默认 `responses` |
| `OPENAI_RESPONSE_FORMAT` | `json_schema` 或 `json_object`；默认 `json_schema` |
| `OPENAI_TIMEOUT_MS` | 每次 API 请求的超时毫秒数，默认 `150000`；允许 `1000` 至 `300000` |
| `CODEX_MODEL` | 可选的 Codex 模型覆盖；留空时不传模型覆盖参数 |

修改 `.env` 后，停止并重新运行 `npm start` 即可，**不需要重建 Docker**。网页控制台没有 API key、邮箱或密码输入框，配置在宿主服务端读取。OpenAI 官方要求密钥保密，并从服务器环境变量等位置加载，而非放入网页客户端代码。[API 认证文档](https://developers.openai.com/api/reference/overview#authentication)

如果终端已经设置了同名环境变量，它会优先于 `.env`。本地回环地址 `localhost`、`127.x.x.x` 或 `::1` 可使用 HTTP，其他 API 地址要求 HTTPS。

### 使用 Codex 登录

安装 Codex CLI 后，在运行 demo 的同一系统账号下执行：

```powershell
codex login
codex login status
```

`codex login` 会打开官方浏览器授权流程。demo 复用本机 CLI 的登录状态，不收集 OpenAI 邮箱密码，不要求复制或上传 `auth.json`；Codex 负责保管和更新登录凭据。[Codex 身份验证文档](https://learn.chatgpt.com/docs/auth)

这条路径不要求在 `.env` 填 API key。使用 ChatGPT 登录时消耗对应账号的 Codex 额度；如果你的 CLI 本身使用 API key 登录，则其计费仍取决于该认证方式。

### 使用 API key 或兼容服务

填写 `.env` 中的 `OPENAI_API_KEY`，设置 `OPENAI_MODEL`，并根据服务提供方的协议填写 `OPENAI_BASE_URL`、`OPENAI_API_STYLE` 和 `OPENAI_RESPONSE_FORMAT`。API 路径不需要登录 Codex；使用 OpenAI API 时，费用按 API 账户单独计费，不抵扣 ChatGPT 订阅包含的 Codex 额度。[官方计费与认证说明](https://learn.chatgpt.com/docs/auth)

示例模型 `gpt-4.1` 支持图片输入、Responses、Chat Completions 和结构化输出。它是配置示例，不表示你的 API 账号或第三方服务一定可以访问该模型。[GPT-4.1 模型文档](https://developers.openai.com/api/docs/models/gpt-4.1)

兼容服务必须接受截图输入，并支持所选 JSON 输出格式。`json_schema` 用于要求匹配动作结构；`json_object` 用于只提供 JSON 对象模式的服务，结果仍需通过本地动作检查。demo **不会自动切换协议或降级输出格式**；若服务不兼容，请明确修改配置后重启。

第三方 `OPENAI_BASE_URL` 会接收本次任务的截图、目标、动作反馈和你填写的 API key。只使用你信任且有权使用的服务，并填写该服务要求的密钥；不要误把 OpenAI 密钥发送给不可信地址。

控制台中 API 的“就绪”仅表示本地配置通过校验，**不代表密钥、模型权限或实际请求已验证**。状态区域会说明验证情况；点击“开始执行”后才会请求模型并产生相应 API 用量。没有真实 API key 时，只能做配置与 mock 协议测试，不能据此认定真实 API 路径已经跑通。

## 体验一次任务

1. 选择“几何画板”或“钥匙迷宫”，保留默认目标，或改成你想尝试的目标。
2. 可点击“换一个布局”，让下一次运行使用新的 `seed`。两种实验页各有三种布局或关卡，数字按三种变体循环；已经打开的实时桌面不会因此提前切换。
3. 选择最多观察轮数，然后点击“开始执行”。浏览器会在容器中打开本次目标网页。
4. 在中间查看容器实时桌面，在右侧查看按时间排列的截图、简短观察摘要、动作和执行结果。
5. 完成后查看结果和下载文件；也可以随时点击“停止任务”。

两个内置目标：

| 场景 | 默认目标 | 可观察的行为 |
| --- | --- | --- |
| 几何画板 | 在画布中央画一个红色实心矩形，并导出 PNG | 识别工具栏、选工具和颜色、拖拽绘制、点击导出 |
| 钥匙迷宫 | 阅读规则，拿到钥匙，再走到出口通关 | 从画面读地图、使用方向键逐格移动、检查钥匙与通关状态 |

“其他网页”支持填写外部 HTTP/HTTPS 网址和目标。它使用新的容器浏览器配置，不继承宿主浏览器的登录态；自定义目标不接受本机地址。复杂登录、验证码、隐藏规则和高速游戏都可能超出这个 demo 的能力，不能保证任意陌生网页都能完成。

“最多观察轮数”是上限，不是必须执行的次数。模型可能提前确认完成、报告无法继续，或用完观察轮数；动作发送成功也不等于用户目标已经完成。

## 实时桌面与模型截图

控制台默认显示“容器实时桌面”。这由 noVNC 持续显示容器中的 Xvfb 桌面，采用只读视图；“新窗口看桌面”会打开同一个桌面。切换任务、开始或停止模型，不会让控制台重新创建一个本机实验页预览。

“模型看到的截图”显示模型实际接收的 PNG，仅在代理重新观察时更新。点击右侧某轮的“查看模型当时看到的画面”可以回看历史截图；它和当前实时桌面可能不同。“返回最新截图”回到最近一次模型观察。

Docker 未就绪时，控制台会明确显示环境状态并禁用开始按钮。任务完成后，容器保留最后的浏览器画面，记录和截图也会保留。

点击“停止任务”会取消当前请求并关闭容器内的当前浏览器；最后的静态截图和记录保留，noVNC 桌面服务继续运行。

## 决策与执行如何连接

```text
宿主 Node.js 控制台与代理循环
    │
    ├─ PNG 截图 + 用户目标 + 最近动作与反馈
    │      → Codex CLI 或配置的模型 API → 简短摘要与结构化动作
    │
    └─ HTTP :8000 → 容器截图与动作服务
                        ├─ 截取 Xvfb 桌面的 PNG
                        └─ 执行鼠标 / 键盘操作 → Chromium 网页

用户浏览器 → noVNC :6080 → VNC over WebSocket → 同一个 Xvfb 桌面
```

宿主按 `.env` 选择 Codex CLI 或模型 API 来获取决策。宿主服务检查动作类型和坐标，再通过带本机控制令牌的 HTTP 请求，让容器执行点击、拖拽、输入、按键、滚动或等待。随后重新截图，把结果送入下一轮。

noVNC 的 WebSocket 负责向用户展示桌面，**不是模型的决策通道**。模型只接收 PNG 截图、任务目标和动作反馈等信息，不接收网页 DOM、页面源码、隐藏游戏状态或解题路径。右侧展示的是简短观察摘要和实际动作，不展示模型内部推理。

画板和迷宫共用同一套模型提示词与执行器，没有针对场景的专用解法。模型需要从截图中识别按钮、颜色、规则和结果；页面自身负责处理普通鼠标键盘输入。

## 文件、记录和会话重置

每次运行在宿主 `runs/` 中建立独立目录：

```text
runs/<run-id>/
  screens/       每轮观察的 PNG 截图
  downloads/     从容器取回的下载文件，例如画布作品 PNG
  trace.json     任务结束时保存的运行记录
```

控制台结果区域提供文件下载链接；任务结束后，右侧“保存记录”可下载 `trace.json`。记录用于核对模型看到了什么、提出了哪些动作、实际执行是否成功。

下一次运行会重置容器中的 Chromium 配置目录和容器下载目录，清除上一次浏览器会话。已经取回宿主 `runs/` 的截图、下载和记录继续保留。重启控制台后，可直接在 `runs/` 查看旧记录；当前界面不是完整的历史任务管理器。

## 验证范围

已有的真实模型验证使用 Codex CLI 登录路径，运行环境为 Windows 与 Docker Desktop Linux 容器：

- 真实 AI 画板任务（seed 1）：3 轮模型决策，选择红色、拖拽中央矩形、导出 PNG。已打开导出文件核对，画布为 700 × 440，中央为红色实心矩形。
- 真实 AI 迷宫任务（seed 2）：4 轮模型决策、10 次方向键输入；最终截图同时显示“已获得钥匙”和“已通关”。没有给模型输入页面源码或预设路径。
- 开始后立即停止：任务在第 0 轮取消，未发出模型决策请求。
- `npm test`：运行不付费的纯函数与协议回归测试，不请求真实模型；mock 响应只能验证协议处理，不能验证远端服务可用性。
- `npm run smoke`：只读检查通过，覆盖服务健康、无凭据截图被拒绝、noVNC 实时连接、控制台布局和页面错误。该脚本使用本机 Microsoft Edge，不会开始任务或消耗模型额度。

真实运行产物保存在本机 `runs/<run-id>/`，不随公开仓库分发。已有结果说明 Codex CLI 路径下这两个场景已经跑通，不代表任意网站、每次模型运行或 API 路径都能成功。API 接入当前没有使用真实 API key 完成付费端到端验证。

## 核心文件

| 文件 | 职责 |
| --- | --- |
| `server.mjs` | 本机 HTTP 服务、任务循环、事件流、状态与运行记录 |
| `lib/model.mjs` | 统一模型入口，按配置选择模型来源并整理截图上下文与动作反馈 |
| `lib/env.mjs`、`lib/config.mjs` | 载入项目 `.env`、校验配置并选择模型来源 |
| `lib/openai-api.mjs` | Responses / Chat Completions 双协议 API 适配与结构化结果解析 |
| `lib/decision-schema.json` | 模型输出的结构化动作格式 |
| `lib/browser.mjs` | 容器 HTTP 适配器、坐标和动作检查、截图及下载归档 |
| `docker/control.py` | 容器中的会话、桌面截图、鼠标键盘和下载接口 |
| `docker/start-desktop.sh` | 启动 Xvfb、窗口管理器、VNC、noVNC 与控制服务 |
| `docker/Dockerfile`、`compose.yaml` | 构建桌面环境，配置容器用户、端口与健康检查 |
| `public/index.html`、`public/app.js`、`public/style.css` | 任务控制台、实时桌面、截图历史和事件记录 |
| `public/labs/paint.html`、`public/labs/maze.html` | 两个响应普通鼠标键盘操作的实验网页 |
| `.env.example`、`scripts/setup.mjs`、`start-demo.cmd` | 配置模板、本机配置与容器凭据准备、Windows 启动入口 |

修改实验页或容器内代码后，重新执行 `npm run desktop`，让构建后的文件进入容器。只修改 `.env` 或宿主 Node.js 代码时，重启控制台即可。

## 停止与排查

停止本机控制台：在运行 `npm start` 的终端按 `Ctrl+C`。停止并移除 demo 容器：

```powershell
npm run desktop:stop
```

这个命令执行 `docker compose down`，不会删除宿主 `runs/`。

如果控制台一直提示 Docker 未就绪，先确认 Docker Desktop 引擎可用，再检查：

```powershell
docker compose ps
docker compose logs --tail=80 desktop
```

Codex 模式提示未登录时，先在本机完成 `codex login`，用 `codex login status` 确认，再重启控制台。请求失败也可能与网络、账号可用额度或 CLI 版本有关。

API 模式报错时，检查 `.env` 中的密钥、API 根地址、模型名、协议和 JSON 格式；不要给根地址重复添加 `/responses` 或 `/chat/completions`。本地配置通过校验仍可能遇到密钥无效、模型不可用、余额不足、超时或第三方兼容性问题。修改后重启控制台，demo 不会自动尝试其他协议。

如果提示容器控制凭据不一致，确保 `dockercompose.env` 存在，然后停止并重新启动 demo 容器，再重启控制台。不要把该文件的令牌粘贴到网页目标或任务描述中。

## 本地运行边界

默认端口均绑定宿主回环地址：控制台为 `127.0.0.1:4317`，容器控制接口为 `127.0.0.1:8000`，noVNC 为 `127.0.0.1:6080`。不要直接把这些服务开放到公网。

自定义网址只检查初始 URL 的协议、账号字段和显式本机地址，不做 DNS 或后续导航的网络隔离。请只测试可信页面，不要在这个 demo 中处理付款、敏感账号或恶意网站。

容器没有挂载宿主目录，没有使用 privileged 模式，以非 root 用户运行，并去掉额外 Linux capabilities。Codex 登录凭据与 `.env` 中的 API key 保留在宿主，不传入网页或桌面容器；API key 仅随模型请求发往你配置的 API 服务。

Chromium 当前使用 `--no-sandbox` 启动，浏览器安全浏览功能保留默认设置。这个组合用于个人本地实验，**不能作为生产级安全隔离方案**。任务目标、截图和下载可能包含你打开网页中的内容；分享运行记录前，请检查实际文件。
