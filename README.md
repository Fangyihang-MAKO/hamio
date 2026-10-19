# Ha!mio

Ha!mio 下载网站的静态文件，包含 Android 与 Windows 安装包、角色图片和使用指南。

## 发布到 GitHub Pages

1. 将本目录内的所有文件上传到 GitHub 仓库的 `main` 分支根目录，保留 `assets` 和 `downloads` 子目录。
2. 打开仓库的 **Settings → Pages**。
3. 在 **Build and deployment** 中选择 **Deploy from a branch**。
4. 选择 **main** 和 **/ (root)**，点击 **Save**。
5. 等待 Pages 发布完成，使用页面显示的 `github.io` 网址访问。

无需构建或安装依赖，`.nojekyll` 用于直接发布静态文件。图片和下载链接均使用相对路径，支持仓库子路径。

## 文件说明

- `index.html`：页面内容
- `style.css`：页面样式
- `app.js`：流萤动画和页面交互
- `assets/`：页面图片
- `downloads/`：安装包及 `SHA256SUMS.txt` 校验文件

网站当前提供 Ha!mio 流萤正式版 1.1.4（Android APK 与 Windows EXE），与 Skill MVP 体验包分开。安装包内容与本地正式交付版一致，SHA-256 见 downloads/SHA256SUMS.txt。Windows 便携 ZIP 包含同一 EXE 和使用说明。

本仓库仅放置面向访客公开的网页资源，不包含开发源码、API 密钥、聊天记录或收款码。流萤角色来自《崩坏：星穹铁道》，相关角色与作品权利归原权利方所有；本项目为非官方同人作品。
