# Registry entries

每个已收录插件占一个文件：

```text
registry/entries/<github-owner>/<plugin-slug>.json
```

文件内的 `plugin.id` 必须与路径组成的 `<github-owner>/<plugin-slug>` 一致。不要把示例、
测试 fixture 或临时预约放进本目录；合并到 `main` 的文件就是公共注册记录。
