# DSH 游戏服务插件

开源客户端只携带三条明确标记的演示建议，不包含完整游戏数据库。保留 `site_datasets` / `site_query` 工具名，查询结果仍以 `rows` 数组交给 agent。

## 安装

源码仓库内可运行 `powershell -File tools/install-game-services.ps1` 安装到本机 Desktop；脚本备份配置并切换到演示模式。

将本目录作为 `dsh-game-services` 安装到 DSH profile 可解析的 node_modules。依赖由已有 DSH runtime 提供。Desktop patch 中替换原 `site-assistant` 插件，避免重复注册同名工具：

```yaml
- id: site-assistant
  name: dsh-game-services
  config:
    mode: demo
```

正式检索使用 `mode: remote`，配置 `serviceBaseUrl: https://你的服务地址` 和 `tokenEnv: JINBAO_SERVICE_TOKEN`。插件每次请求通过 DSH 原生凭据管理器解析服务令牌（兼容继承环境）；不会把凭据放进工具输出。修改后重新加载 Desktop。

## 两种模型方案

`desktop-models.example.yml` 给出原生 `llm-pi-ai` 配置，需替换占位地址与模型 ID 并合并到已有 providers。BYOK 使用用户选定厂商地址与用户 key；云端模式使用你的 `/v1/chat/completions` 和服务令牌。模型选择仍由 Desktop 原生 agent 负责，不引入嵌套模型工具。

数据检索独立请求 `/site/search`，即使用户自带模型 key，仍需你的检索服务权限。当前云端代理仅接收文本消息，支持工具调用和 SSE；现有视觉模型路由保留在 Desktop 原配置中。

## 发布边界

`npm pack --dry-run` 的 files 白名单只包含插件、客户端、说明及配置示例。不要把 `workspace/lol-data`、`workspace/site-release`、private 映射或服务密钥放进开源发布包。多游戏接口已预留 game ID；当前真实索引仅有 lol，尚未实现所有游戏自动识别或在线攻略采集。
