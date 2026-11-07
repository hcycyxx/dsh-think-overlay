# Discover 安装 / Install through Discover

索引地址 / Index URL:

```text
https://raw.githubusercontent.com/hcycyxx/dsh-think-overlay/main/market/index.json
```

## 使用

在 **插件 → 实验性插件** 中启用 **自定义插件市场 / Custom plugin markets**（部分版本为 Custom plugin indexes），打开 **发现 / Discover**，添加上述索引源。已有其他来源时，通过市场菜单打开 **管理索引源…** 添加，保留原有来源。

选择 **hcycyxx 思考悬浮窗**，搜索「思考悬浮窗」或 `dsh-think-overlay`。安装前核对完整包名 **dsh-think-overlay**、版本与来源 **Git 仓库 `hcycyxx/dsh-think-overlay`**（固定 commit），确认并按提示重启；桌面版刷新网页即可。已安装卡片会打开现有插件，无须重复安装。

本索引使用 **Git 源**，指向仓库里含最终 `package.json`（声明 `dsh.bundle`）的固定提交，因此**不需要 npm 账号、不需要先发布到 npm**。这是维护者自托管的社区索引，添加后才会出现在当前 profile 的 Discover 中；发布索引不会自动加入其他用户的配置或其他社区目录。插件设置与数据说明见 [README](../README.md)。

## English

Enable **Custom plugin markets / Custom plugin indexes** under **Plugins → Experimental plugins**, then open **Discover** and add the index URL above. If sources already exist, use **Manage index sources…** in the market menu. Select **hcycyxx Think Overlay**, search for **Think Overlay**, and verify the exact **dsh-think-overlay** version and the **Git source** (repo `hcycyxx/dsh-think-overlay`, pinned commit) before confirming. Restart when prompted; on Desktop a page refresh is enough. Already installed cards open the existing plugin.

This index uses a **Git source** pinned to a commit that contains the final `package.json` (declaring `dsh.bundle`), so **no npm account and no npm publication are required**. The index belongs to the current profile; other users and profiles must add it separately.

## 加载排查 / Troubleshooting

- 没有 Discover 标签：检查实验性插件是否启用。 / No Discover tab: enable the experimental plugin.
- 索引加载失败：打开管理索引源查看错误，确认网络能直接访问上面的 GitHub Raw 地址，再刷新索引。 / Loading fails: inspect the source error, check access to GitHub Raw, then refresh.
- 安装时提示找不到包：确认所指向的 commit 已推送到公开仓库、且该提交的根目录有 `package.json` 与 `dsh.bundle`。 / Install cannot find the package: make sure the pinned commit is pushed and its root has `package.json` with `dsh.bundle`.
- 没有可安装版本：核对 DSH 版本与索引里的 `versions[]`。 / No compatible version: check the DSH version against the listed versions.

## 维护 / Maintenance

`market/index.json` 使用 DSH `format: 1`。Git 源版本必须写明 `source.type: "git"`、`source.url`（https 仓库地址）、`source.commit`（40 位 hex、已推送且根目录含最终 `package.json` 的提交）；仓库根目录即包根目录，故不填 `path`。图标以内联 `data:image/svg+xml;base64,…` 提供，由 `market/icon.svg` 生成，无须额外请求。

发布新版本时：先把最终代码提交并推送，拿到该提交 sha，再更新 `versions[]`、`dist-tags.latest` 与 `publishTimestamp`（Unix 秒，取该提交时间或发布时间）。不要指向尚未推送或不含最终代码的提交。索引无需随插件安装，也无需为了修改索引重新打包旧版本。包若已发布到 npm，也可把 `source` 改成 `{ "type": "npm", "registry": "https://registry.npmjs.org" }`，两种源不能混用于同一版本。

格式和界面依据 / Format and UI: [DSH plugin markets](https://deepseek-harness.github.io/deepseek-harness/en/guide/plugin-market).
