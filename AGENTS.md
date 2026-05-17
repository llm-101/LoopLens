# Agent / AI 协作说明

## 修改代码后的打包（必选）

在完成与本仓库相关的**功能性或样式修改**（尤其是 `desktop/` 前端、`desktop/src/styles.css`、`desktop/src-tauri/`）之后，应在会话结束前执行桌面产物打包，用于尽早暴露编译 / Tauri / Vite 问题。

在项目根目录下：

```bash
cd desktop && npm run build
```

成功后可安装的 macOS 应用位于：

`desktop/src-tauri/target/release/bundle/macos/LoopLens.app`

**请勿**擅自启动或重启用户本地的「前端开发服务器」或 Python 服务；用户自行控制。打包命令（`npm run build`）属于一次性构建，不在此限制内。

## UI 与清晰度基准

- **设计稿按「逻辑像素 1×」做**：布局与字号以 CSS **px**（与 macOS **pt** 在标准密度屏上等价）为准；Retina / HiDPI 由系统自动按设备倍率绘制，**不要把界面宽度写成物理像素二倍**。
- **字体**：桌面端通过 `@fontsource-variable/inter` 打包 **Inter 可变字体**，系统中文仍走栈里的苹方 / 微软雅黑等；字号与字重 token 见 `desktop/src/styles.css` 顶部及各段 `:root` 中的 `--text-*`、`--fw-*`。
