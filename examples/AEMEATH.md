# 项目记忆示例（复制到你的项目根目录，命名为 AEMEATH.md）

# 项目记忆

- 技术栈：Node.js 20 + TypeScript，npm workspaces
- 构建：`npm run build`
- 测试：`npm test`
- 代码风格：2 空格缩进，使用 ESM（`.js` 后缀导入）

## 约定
- 不要直接修改 `dist/` 下的产物，改 `src/` 后重新构建
- 提交信息使用中文，格式：`类型(范围): 描述`
- 新增依赖前先确认必要性

## 重要路径
- 入口：`src/index.ts`
- 配置：`src/config/`
