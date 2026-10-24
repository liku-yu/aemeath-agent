# 应用图标

## 组成

```
底块    圆角方块，圆角 138/512（等于界面里 .avatar 的 14/52）
        渐变 linear-gradient(160deg, #3a2440, #241629)，取自 --bg-avatar-lo / --bg-avatar
图形    Lucide 的 sparkle，填充而非描边，占方块 64%
```

**为什么填充而不是描边**：Lucide 是 2px 描边的线性图标，缩到 16px 时描边只剩
1.3 个像素，糊成一团。实心四角星在 16px 下仍然是一个清晰的记号。

**为什么占 64%**：58.6% 时 16px 里暗色块占比过重，星芒像个「+」号；64% 之后
小尺寸有存在感，大尺寸也没顶到边缘。

## 重新生成

```bash
npm run icon
```

`scripts/make-icon.mjs` 会：

1. 以 Electron 重跑自己（项目里没有 SVG 光栅化库，Electron 自带的 Chromium 就是）
2. 隐藏窗口里按 16/24/32/48/64/128/256 **逐档渲染**矢量源 —— 不是从 256 缩下来的，
   所以 16px 的笔画不会走形
3. ≤128 写成 32 位 BMP 条目（含 Windows 必需的 AND 掩码），256 写成 PNG 条目
4. 输出 `icon.ico` 和 `icon.png`

源文件是 `icon-source.svg`，改颜色/大小/图形都改它。

## 构建怎么用它

- `build.win.icon` → exe
- `build.nsis.installerIcon` / `uninstallerIcon` → 安装器

## 授权

图形来自 Lucide，ISC 协议，原文见 `ICON-LICENSE.txt`。
`pet/spritesheet.webp`（桌宠图集，MIT）跟这个图标无关。
