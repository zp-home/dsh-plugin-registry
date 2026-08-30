# Contributing

本仓库只接受 DSH 插件注册表、冲突检测规则、Schema、CLI、Action 和治理文档相关改动。
Agent Skill、插件实现与命名风格校验器应在各自仓库维护。

## 登记插件

1. Fork 本仓库并基于最新 `main` 创建分支。
2. 复制 `registry/examples/plugin-registration.example.json`。
3. 保存到 `registry/entries/<github-owner>/<plugin-slug>.json`。
4. 重新生成索引并运行验证。
5. 使用 `register-plugin.md` PR 模板提交登记。

```sh
npm run build:index
npm run validate
npm test
```

路径、`plugin.id` 和仓库 GitHub owner 必须一致。普通能力冲突是审核信息；身份冒用、无效
清单、错误路径和过期索引不能合并。只有合并到 `main` 的登记才构成公共记录。

## 修改检测逻辑

保持工具无运行时依赖，不下载或执行登记插件的代码。新增冲突种类时同步修改 Schema、示例、
输出文档和回归测试。PR 必须说明默认告警模式与严格模式的行为是否变化。
