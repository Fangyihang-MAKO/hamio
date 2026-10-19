# Ha!mio 角色创作间

这是可操作的两步网页界面。生成接口尚未连接，不会调用模型或收取生成费用。
示例图复用网站已有流萤素材；新增角色素材、付费、用户账号、桌宠安装包制作均不在本次范围内。

## 当前流程

1. 添加角色参考图片，设置描述、风格和候选数量；使用明确标注的流萤示例体验候选选择。
2. 确认一张角色图，选择一个或多个姿态；可针对不满意的姿态准备单独的重做请求，保留其他卡片。

上传图只在本页面内存中处理。没有自动上传、账号保存或跨设备同步。
未接入服务时点击生成会说明服务未接入，不会将旧素材冒充生成结果。

## 留给后续图片服务的接口

`api.js` 暴露：

```js
getGenerationStatus(); // { configured: false, label: '图片生成接口待接入' }
generateChibi(request, { signal });
generatePoses(request, { signal });
setGenerationAdapter({ generateChibi, generatePoses });
```

默认不安装 adapter，两种生成方法都抛出 `GenerationUnavailableError`，错误码为 `GENERATION_NOT_CONFIGURED`。
后续在可信应用代码中安装 adapter，由它完成上传、提交任务、轮询进度并返回最终图片。UI 无需知道模型提供方。

Q 版请求的建议结构：

```json
{
  "references": [{ "id": "ref-1", "name": "character.png", "dataUrl": "data:image/png;base64,..." }],
  "description": "角色特征及希望保留的细节",
  "style": "soft",
  "count": 4
}
```

姿态请求的建议结构：

```json
{
  "baseImage": { "id": "chosen-chibi", "dataUrl": "data:image/png;base64,..." },
  "poses": [{ "id": "happy", "name": "开心", "description": "双手靠近脸颊，保持服装和画风" }],
  "revision": 1
}
```

两种方法返回：

```json
{
  "images": [
    { "id": "unique-result-id", "dataUrl": "data:image/png;base64,...", "poseId": "happy", "source": "generated" }
  ]
}
```

`dataUrl` 必须为 PNG/JPEG/WebP 的 base64 data URL，方便下载与保存完整设计记录。若服务商返回图片 URL，由后端适配器获取并转换，不把临时链接或服务商密钥交给前端。`source` 必填，取 `generated` 或 `demo`。
`poseId` 用于把返回图片匹配到对应姿态，服务必须只返回请求指定的姿态。示例不可标为 `generated`。
重新绘制时保持同一个姿态 ID、使用新的结果 ID；保留未重做的姿态。
切换角色时增加 revision 并取消旧请求，忽略过期响应。adapter 应响应传入的 `AbortSignal`。

后续 HTTP 服务可采用：

- `POST /api/studio/assets`：上传图片并获得素材 ID。
- `POST /api/studio/jobs`：提交 Q 版或姿态任务。
- `GET /api/studio/jobs/:jobId`：逐张查询状态和结果。

这些是接入约定，不是当前已经部署的服务器。生成服务的 API 密钥只能放在后端，不能写进静态网站、GitHub 或导出的设计记录。
开放真实生成前需增加身份校验、调用限额和服务端输入校验，并明确图片发送到哪家服务。

## 本地预览

在 `github-pages/` 目录启动静态 HTTP 服务，打开 `/studio/`。需要通过 HTTP 访问 ES modules，不能双击 `index.html` 以 file URL 打开。
此页无需 npm 安装或构建，可随现有 GitHub Pages 网站发布。
