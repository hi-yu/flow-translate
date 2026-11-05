# 开发指南

[← 返回 README](../README.md)

## 环境与构建

需要 Node.js 20.19+ 和 npm。项目使用 TypeScript、esbuild、Vitest 与 Playwright，Chrome 扩展遵循 Manifest V3。React 与 Slate 仅用于测试，不打入扩展运行时。

```sh
npm ci
npm run build
```

构建产物位于 `dist/`。打开 `chrome://extensions`，开启开发者模式并加载该目录。修改代码后重新构建、重新加载扩展，再刷新原网页。

| 命令                   | 用途                                 |
| ---------------------- | ------------------------------------ |
| `npm run build`        | 构建 Chrome 扩展                     |
| `npm run typecheck`    | TypeScript 严格类型检查              |
| `npm test`             | 运行单元测试                         |
| `npm run test:e2e`     | 运行浏览器测试                       |
| `npm run format:check` | 检查格式                             |
| `npm run format`       | 格式化项目文件                       |
| `npm run check`        | 类型检查、单元测试与构建             |
| `npm run package`      | 构建并生成 `releases/` 中的 ZIP      |
| `npm run keygen`       | 首次生成本机 CRX 签名私钥            |
| `npm run package:crx`  | 构建 ZIP、签名 CRX 和校验文件        |
| `npm run test:release` | 验证签名、版本约束及 GitHub 上传逻辑 |

`dist/`、`releases/` 和测试产物不纳入 Git。ZIP 根目录包含 `manifest.json`，分发时先解压再加载。

在已同步的 main 分支运行 `npm run release` 后，CNB 会自动构建并同步正式版到 GitHub。

## 项目结构

```text
flow-translate/
├── public/             # Manifest、设置页、弹窗、样式与图标
├── src/                # 后台、内容脚本、翻译适配与界面逻辑
├── tests/
│   ├── unit/           # 协议、队列、偏好与 DOM 逻辑测试
│   ├── e2e/            # Chrome 扩展与真实弹窗回归
│   └── fixtures/       # 网页、React 控制台与 Slate 编辑器
├── scripts/            # 构建与打包
├── docs/               # 使用和开发文档
├── CHANGELOG.md
└── VALIDATION.md
```

| 模块                                       | 职责                                        |
| ------------------------------------------ | ------------------------------------------- |
| `background.ts`                            | 鉴权、设置、权限与消息入口                  |
| `providers.ts`                             | OpenAI 兼容、DeepL、Gemini 的翻译与模型列表 |
| `translation-engine.ts`                    | 队列、优先级和会话缓存                      |
| `page-auto.ts`                             | 按域名注册持久内容脚本                      |
| `page-dom.ts` / `page-translator.ts`       | 原位翻译、原文恢复和过期结果处理            |
| `content.ts` / `dom.ts`                    | 页面接入和 Discord 消息控件                 |
| `discord-context.ts`                       | 频道、发送方来源和当前标签页校验            |
| `discord-draft.ts` / `discord-composer.ts` | 草稿快照、编辑器回填和输入框翻译按钮        |
| `source-language.ts`                       | Chrome 本地语言识别                         |
| `options.ts` / `popup.ts`                  | 设置页和扩展弹窗                            |

上述模块均位于 `src/`。

## 测试

```sh
npm run format:check
npm run check
npx playwright install chromium
npm run test:e2e
```

浏览器测试创建临时隔离配置，使用模拟网页、Discord 页面、翻译服务以及真实 React / Slate 编辑器，不读取已有 Chrome 配置或 Discord 登录状态。

`tests/e2e/popup.spec.ts` 需要能够启动可见 Chromium 的桌面环境，通过真实工具栏 action 检查弹窗尺寸和坐标点击；其余功能测试使用无头 Chromium。默认跳过本机模型及两个真实 AWS 公共页测试。

### 本机模型集成

```sh
FLOW_TEST_LOCAL=1 npm run test:e2e
```

需要已启动的模型服务、鉴权网关和 API Key 文件。测试会从私有文件读取密钥，写入临时扩展配置，并在结束后删除测试浏览器配置。可通过下列环境变量覆盖默认值：

| 变量                  | 默认值                                    |
| --------------------- | ----------------------------------------- |
| `FLOW_LOCAL_BASE_URL` | `http://127.0.0.1:11434/v1`               |
| `FLOW_LOCAL_MODEL`    | `hy-mt2-7b:q6_k`                          |
| `FLOW_LOCAL_KEY_FILE` | `~/.config/local-translation/api-key.txt` |

这是可选测试约定，扩展本身不会读取该密钥文件。模型服务和鉴权网关的部署不包含在本仓库中；默认本地预设要求带鉴权的 OpenAI 兼容接口。

### AWS 公共页验证

```sh
FLOW_TEST_AWS=1 npm run test:e2e
```

需要外网，使用模拟翻译服务验证 EC2 公共页及 Free Tier 导航的结构和交互，不访问登录后的 AWS 控制台，也不评估模拟译文质量。

两类集成验证可同时开启：

```sh
FLOW_TEST_LOCAL=1 FLOW_TEST_AWS=1 npm run test:e2e
```

最近一次完整功能验证为 84 项单元测试、47 项浏览器测试，具体环境、结果和边界见[验证记录](../VALIDATION.md)。

## 贡献与问题反馈

请在功能或修复分支修改代码，保持变更范围明确，并运行与改动相关的检查。涉及行为变化时同步更新使用说明和更新记录。

反馈问题时提供 Chrome / 扩展版本、网站或频道类型、复现步骤、预期行为与实际结果。涉及接口时注明服务商和错误码；提供示例时使用虚拟密钥和脱敏内容。

提交说明应描述具体问题、修改后的行为和验证结果。PR 需指定明确的人工评审人，最终合并由人工维护者执行。
