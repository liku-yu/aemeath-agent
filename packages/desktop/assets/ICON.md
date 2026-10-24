# 应用图标

`icon.ico` / `icon.png` 由 `pet/spritesheet.webp` 裁出来，不是手绘的：

- 取 idle 动画第 1 帧（左上角单元格，192×208）
- 只裁头肩：`(3, 41) - (189, 175)`，再按实际像素收紧
- 内容居中补成正方，透明背景
- 256 档用 NEAREST 放大（像素画放大要保住硬边，不能用平滑插值）
- 尺寸：16 / 24 / 32 / 48 / 64 / 128 / 256

为什么要裁掉翅膀：完整那一帧的 bbox 会伸进底部翅展，头在 16px 下就糊成一团。

素材来源与许可见 `pet/NOTICE.md`（MIT）。换图后重跑一次裁切即可；
electron-builder 通过 `build.win.icon` 和 `build.nsis.installerIcon` 引用它。
