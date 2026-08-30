# DSH 插件冲突注册表

这个目录是 DSH 社区插件的公共协调层。它记录插件主动声明的 ID、服务、工具、命令、
Skill、HTTP 路由和端口，帮助开发者在发布前发现已知冲突。注册表不下载、不安装，也不
执行第三方插件代码。

这是一个独立基础设施仓库，不是 Agent Skill，也不属于任何 Skill 仓库。Skill、插件开发
工具和第三方 CI 都只是它的客户端；中央数据、Schema、校验器与审核历史只保存在这里。

注册表只能反映已经合并到 `main` 的公开登记，不是全网唯一性证明。未登记插件、运行时
动态生成的名称，以及语义相同但写法不同的路由都可能无法发现。

## 查询

机器可读索引（静态只读 API）：

```text
https://raw.githubusercontent.com/zp-home/dsh-plugin-registry/main/registry/index.json
```

克隆本仓库后可以做精确查询：

```sh
node scripts/plugin-registry.mjs search --kind service --name aliceSearch --index registry/index.json
node scripts/plugin-registry.mjs search --kind id --name alice/dsh-search --index registry/index.json
node scripts/plugin-registry.mjs search --kind port --name tcp:43123 --index registry/index.json
node scripts/plugin-registry.mjs search --kind route --name "GET /api/plugins/alice-search/status" --index registry/index.json
```

`--kind` 支持 `id`、`package`、`loader`、`service`、`tool`、`command`、`skill`、
`route` 和 `port`，也支持索引里的复数形式。查询是大小写敏感的精确匹配。

检查一个待发布插件：

```sh
node scripts/plugin-registry.mjs check \
  --manifest dsh-plugin.registry.json \
  --registry-url https://raw.githubusercontent.com/zp-home/dsh-plugin-registry/main/registry/index.json
```

普通能力冲突默认输出告警并返回成功；添加 `--strict` 后，任何已知冲突都以退出码 `2`
阻断 CI。清单格式错误或插件身份被其他仓库占用始终以退出码 `1` 阻断。

## GitHub Action

插件仓库可以直接接入本仓库内的复合 Action：

```yaml
name: dsh-plugin-conflicts

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zp-home/dsh-plugin-registry/.github/actions/check-plugin-conflicts@main
        with:
          manifest: dsh-plugin.registry.json
          strict: 'false'
```

默认模式下，中央索引暂时不可访问只会产生告警，避免网络故障拖垮插件 CI；`strict: 'true'`
时索引不可用也会失败。无论是否严格，插件清单无效和身份冲突都会失败。生产项目可在本仓库
发布稳定版本后，把 `@main` 固定到对应版本 tag 或提交 SHA。Action 代码版本与注册数据版本
相互独立；默认持续查询本仓库 `main` 上的索引，也可以通过 `registry-ref` 或 `registry-url` 覆盖。

## 登记插件

1. 复制 [`registry/examples/plugin-registration.example.json`](registry/examples/plugin-registration.example.json)，填写真实公开元数据。
2. 保存为 `registry/entries/<github-owner>/<plugin-slug>.json`；文件路径必须等于 `plugin.id`。
3. `plugin.repository` 必须是该 GitHub owner 下的规范 HTTPS 仓库地址。
4. 运行索引生成和验证命令。
5. 提交一个注册 PR；在 PR URL 后添加 `?template=register-plugin.md` 载入登记模板，并说明有意保留的冲突。

```sh
node scripts/plugin-registry.mjs build-index
node scripts/plugin-registry.mjs validate --check-index --format markdown
node scripts/plugin-registry.check.mjs
```

PR 创建不等于预留成功，只有合并到 `main` 后才成为公共记录。维护者审核身份、路径和数据
完整性；普通能力冲突不自动拒绝，但检查结果会明确列出冲突值和涉及的插件仓库。更新已登记
插件时修改原文件，不新建第二份身份记录。

## 冲突语义

| 类型 | 默认结果 | 严格模式 | 说明 |
|---|---|---|---|
| 清单、路径或 schema 无效 | 阻断 | 阻断 | 注册数据无法可靠索引 |
| 相同插件 ID 指向不同仓库 | 阻断 | 阻断 | 防止身份冒用或误登记 |
| loader ID、包名、服务、工具、命令、Skill 或路由重复 | 告警 | 阻断 | 是否真冲突取决于插件组合和作用域 |
| 两个插件要求同一固定端口 | 告警 | 阻断 | 同机运行时通常会绑定失败 |
| 重复端口中少于两个是固定端口 | 提示 | 阻断 | 至少一方可配置，通常可以规避 |

名称和路由目前按登记值精确比较；端口按 `<protocol>:<port>` 比较。命名风格与前缀规范由
独立的本地命名校验器负责，本注册表只处理跨插件的已知占用关系。

## 仓库治理

中央仓库应在 GitHub 中启用以下保护，避免两个基于旧索引的 PR 并发合并：

- 将 `plugin-registry / validate` 设为必需状态检查；
- 至少需要一名维护者批准注册 PR；
- 要求分支在合并前更新，或启用 GitHub merge queue；
- 禁止绕过 `main` 分支保护直接写入登记目录。

索引由登记文件确定性生成，`registry/index.json` 不接受手工编辑。工作流只读取 PR 内容，
不会 checkout 或执行登记插件仓库里的代码。
