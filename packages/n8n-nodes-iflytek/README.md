# n8n-nodes-iflytek

iFly-Skills 面向自托管 n8n 的社区节点包，将讯飞能力封装为独立节点，通过共享 `IflyApi` 凭证和 Python 执行层调用仓库中的 Skill 脚本。当前包含翻译、文本校对、票据 OCR、Hyper TTS 四个节点，以及脚本分发、JSON 协议、binary 处理、进程控制和离线测试。

当前版本为 `0.0.0-dev.0`，保留 `private: true`，处于开发预览状态，尚未发布 npm。

## 当前节点与能力范围

| n8n 显示名 / 节点类 | 已启用操作 | 输入与输出 |
| --- | --- | --- |
| iFlytek Translate / `IflyTranslate` | `translate` | 文本或 UTF-8 文本 binary → 原文、译文及源/目标语言 |
| iFlytek Text Proofread / `IflyTextProofread` | `check` | 文本或 UTF-8 文本 binary → 校对服务的结构化结果 |
| iFlytek Invoice OCR / `IflyOcrInvoice` | `recognize` | 票据图片或 PDF binary → 识别结果；可解析为 JSON 时返回结构化数据，否则返回文本 |
| iFlytek Hyper TTS / `IflyHyperTts` | `synthesize` | 文本或 UTF-8 文本 binary → 合成信息及 MP3 音频 binary |
| 同一 Hyper TTS 节点 | `listVoices` | 读取随包分发的默认音色、免费音色及完整音色列表静态数据 |

四个节点的内部名称分别为 `iflyTranslate`、`iflyTextProofread`、`iflyOcrInvoice` 和 `iflyHyperTts`，每个节点对应一个 Skill。

[skills.json](skills.json) 记录仓库 11 个 Skill 的节点/操作映射，其中九个原子 Skill 的 10 个 Python 脚本已纳入构建白名单。通用 PDF/图片 OCR、极速转写、图片理解、视频翻译、声音克隆的脚本虽已随包分发，但尚未启用对应节点与 bridge 操作。票据节点的 PDF 输入属于票据识别，不等同于通用 PDF OCR 能力。

合同审核是编排流程，其 OCR、翻译和 LLM 客户端仍有实现缺口，当前未打包为可执行操作；清单中的目标凭证类型为 `iflyApi`。Animated Sketch Diagram 的现有 JavaScript 渲染器不读取 API 凭证，本包尚未提供其 adapter，也未打包渲染资源及浏览器/ffmpeg 依赖。

实际节点注册以 [package.json](package.json) 的 `n8n.nodes` 为准；已启用操作、所需凭证字段及产物 MIME 类型以 [python/operations.json](python/operations.json) 为准。Skill 清单和脚本分发范围不代表所有能力均已接入 n8n。

## 总体结构与执行方式

```text
n8n 节点 → executeSkill → PythonRunner → child_process.spawn
         → Python bridge → 随包 Skill 模块 → 讯飞服务或本地静态数据
         ← JSON 结果与产物 ← n8n binary 持久化 ← 临时目录清理
```

节点负责表单参数和逐 item 执行，公共层负责凭证、进程、协议和文件生命周期，bridge 使用固定分派表调用原 Python 模块。每次调用启动一个 Python 子进程，通过 stdin/stdout 交换单请求 JSON。服务签名和请求由各 Skill 客户端处理；不拼接工作流输入为 shell 命令，也不依赖常驻适配网关。

| 目录/文件 | 职责 |
| --- | --- |
| `nodes/Ifly*/`、`nodes/common.ts` | 四个节点类、表单、管理员运行配置、逐 item 调用及继续失败处理 |
| `credentials/IflyApi.credentials.ts` | 共享 `iflyApi` 三字段凭证；API Key/Secret 为密码输入 |
| `skills.json` | 11 个 Skill 的节点/操作映射、凭证类型、原脚本白名单与未接入能力说明 |
| `shared/PythonRunner.ts` | 公共执行入口：排队、独立环境、协议校验、产物收集与回收 |
| `shared/processControl.ts` | `spawn`、输出限额、超时/取消终止与每 worker 共享队列 |
| `shared/executeSkill.ts` | 对接 n8n 凭证、取消信号、binary helper、item 关联与错误映射 |
| `shared/binaryFiles.ts` | 每次调用的临时文件、产物路径/大小检查和清理 |
| `shared/credentialEnv.ts`、`protocol.ts`、`errors.ts`、`operationManifest.ts` | 环境白名单、JSON 协议、固定错误信息和启用操作校验 |
| `python/bridge.py`、`python/operations.json` | Python 入口、业务 adapter 及已启用操作清单 |
| `python/requirements-core.lock` | 九个原子能力的直接与间接依赖版本锁；不是平台 wheel/hash 锁 |
| `scripts/clean-dist.mjs`、`scripts/stage-runtime.mjs` | 清理旧编译文件、按白名单复制脚本、校验操作并生成 SHA-256 清单 |
| `tests/` | 包、执行层、adapter 和节点元数据测试；测试 fixture 不进入制品 |
| `dist/`、`runtime/` | 构建生成的编译代码、Python 运行资源及 manifest |

仓库 `skills/` 是业务脚本的源头，`runtime/skills/` 是构建时生成的分发快照，不手工维护第二份业务代码。安装后的运行资源从包自身目录解析，不依赖仓库路径、当前工作目录或 Git。

## 共享凭证与运行配置

在 n8n 中创建 **iFlytek API** 凭证（类名 `IflyApi`，内部名称 `iflyApi`），填写同一讯飞应用的三个字段，并供各服务节点复用：

| n8n 凭证字段 | 子进程环境变量 |
| --- | --- |
| `appId` | `IFLY_APP_ID` |
| `apiKey` | `IFLY_API_KEY` |
| `apiSecret` | `IFLY_API_SECRET` |

当前四个服务操作均需要完整三元组；同一应用须具有对应服务权限。节点通过 `getCredentials('iflyApi', itemIndex)` 读取凭证，再按操作清单构造独立子进程环境。n8n 接入只注入 `IFLY_*`，不依赖原脚本对 `XFEI_*`、`XFYUN_*` 的兼容回退，不从宿主环境读取 API 凭证，也不修改宿主凭证变量。

Hyper TTS 的 `listVoices` 只读取原模块中的 `DEFAULT_VOICE`、`FREE_VOICES` 和 `VOICE_LIST`，不访问讯飞服务端、不需要 API 凭证。它不能验证账户权限或合成效果；**Hyper TTS 的 `synthesize` 语音合成仍需要完整凭证**。静态音色列表也不代表当前账户已开通其中全部音色。

管理员在运行 n8n 的进程环境中配置解释器和临时目录：

| 环境变量 | 用途 |
| --- | --- |
| `IFLYTEK_PYTHON_EXECUTABLE` | 必填，Python/venv 解释器的绝对路径；在执行节点的各进程中可用 |
| `IFLYTEK_TMP_ROOT` | 可选，已存在且可读写的临时目录绝对路径；默认使用系统临时目录 |
| `IFLY_TEST_PYTHON` | 仅测试使用的解释器绝对路径，不替代节点运行配置 |

Windows 配置示例：

```powershell
$env:IFLYTEK_PYTHON_EXECUTABLE = 'C:\path\to\venv\Scripts\python.exe'
$env:IFLYTEK_TMP_ROOT = 'C:\path\to\existing-temp-directory' # 可选
```

Linux/macOS 配置示例：

```sh
export IFLYTEK_PYTHON_EXECUTABLE=/absolute/venv/bin/python
export IFLYTEK_TMP_ROOT=/absolute/existing-temp-directory # 可选
```

配置应在 n8n 启动前生效；服务或容器部署需在其进程配置中设置。解释器、脚本路径和资源限额不作为普通工作流参数。Python 依赖由管理员预装，npm 安装和节点执行均不会自动运行 pip。

## 节点输入与结果使用

翻译、校对和语音合成均可直接填写 **Text**，或将其留空并在 **Input Binary Field** 中填写包含 UTF-8 文本的 binary 属性名。每次选择一种文本来源；这些字段接收文本或 n8n binary 属性名，不接收本地文件路径。

| 节点/操作 | 主要设置 | 结果位置 |
| --- | --- | --- |
| 翻译 | `Source Language` 默认 `cn`，`Target Language` 默认 `en`；语言码与别名由原脚本处理 | `json.data.sourceText`、`translatedText`、`sourceLanguage`、`targetLanguage` |
| 校对 | 提供需要校对的中文文本 | `json.data.result`；保留服务返回的校对结果，不自动应用修订建议 |
| 票据 OCR | `Binary Property` 默认 `data`；支持原票据脚本的 PNG、JPEG、BMP、GIF、TIFF、PDF 输入，bridge 依据文件头设置临时文件扩展名 | `json.data.result` |
| Hyper TTS / Synthesize | `Voice` 默认 `x5_lingxiaotang_flow`；`Speed`、`Volume`、`Pitch` 默认 50，范围 0～100；采样率可选 8000/16000/24000 Hz，默认 24000；可填 `Role` | `json.data` 为合成信息；`binary.audio` 为默认音频输出，文件名 `speech.mp3`，MIME 为 `audio/mpeg` |
| Hyper TTS / List Voices | 选择 `List Voices` | `json.data.defaultVoice`、`freeVoices`、`voices` |

Hyper TTS 的 **Output Binary Property** 默认 `audio`，可设置为以字母开头、仅含字母/数字/下划线且不超过 64 字符的名称。下游通过该 binary 属性读取或保存音频；调用目录会在持久化后清理，本地临时路径不作为跨节点文件接口。文本长度、语言、票据大小及音色/角色权限仍受对应服务限制。

成功输出的 `json` 包含 `protocolVersion`、`requestId`、`ok`、`status`、`data` 和 `meta.durationMs`，业务结果位于 `data` 中。例如，将翻译节点连接到 Hyper TTS，并在后者的 **Text** 中使用 `{{ $json.data.translatedText }}`，可将译文传入合成操作。这是字段连接示例，当前包未提供可导入的工作流模板。

节点按输入 item 顺序执行，结果通过 `pairedItem` 保留输入关联。默认失败会抛出错误；启用 n8n 的继续失败设置后，逐 item 捕获的错误以 `json.error` 返回。公共层不会自动重试服务调用。

## 安装依赖、构建与制品

开发需要 Node.js 24、npm、Git 和 Python 3.10 以上。`n8n-workflow` 的 peer 范围为 `>=2.39.3 <3`；当前开发依赖锁定 `n8n-workflow` 2.39.3、TypeScript 5.9.3 和 `@types/node` 24.13.6。该范围是包依赖声明，具体运行兼容性须经过目标 n8n 实例验证。

从仓库根目录进入包目录安装 JS 依赖，并在仓库外创建独立 Python 环境。以下 `<venv-directory>`、`<venv-python>` 需替换为实际路径：

```sh
cd packages/n8n-nodes-iflytek
npm ci
python -m venv <venv-directory>
<venv-python> -m pip install -r python/requirements-core.lock
<venv-python> -m pip check
npm run build
```

Windows 的 venv 解释器位于 `Scripts/python.exe`，Linux/macOS 位于 `bin/python`。从打包制品安装 Python 依赖时，使用包内 `runtime/requirements/requirements-core.lock`。

`npm run build` 先清理 `dist/`，再编译凭证、节点与公共层，随后重新生成 `runtime/bridge/`、`runtime/skills/`、`runtime/requirements/` 和 `runtime/manifest.json`，避免旧编译文件或旧运行资源混入制品。构建依赖完整仓库及 Git；安装后的脚本快照独立于源码仓库运行。

在包目录检查和生成 npm 制品：

```sh
npm pack --dry-run
npm pack --pack-destination <existing-directory-outside-repository>
```

`npm pack` 会通过 `prepack` 重新构建。制品包含 `dist/credentials/`、`dist/nodes/`、`dist/shared/`、`runtime/`、README、LICENSE 及包元数据；测试、源码构建工具和 `node_modules/` 不进入制品。自托管 n8n 仍需加载该包、满足 peer 依赖并配置 Python；当前未完成实例安装与画布验收。

`runtime/manifest.json` 记录源码 HEAD、Skill/包工作树是否有改动、目录清单摘要、各 runtime 文件 SHA-256/字节数、依赖要求、协议版本和实际启用操作。未提交工作树构建的脚本快照以文件 hash 为准；发布应使用干净、固定提交并重新验收对应制品。

`node_modules/` 是开发依赖目录；`dist/`、`runtime/` 是可重建产物，均被 Git 忽略。`dist/`、`runtime/` 会进入 npm 制品，但不作为源码提交。Python 缓存、临时调用目录和 tarball 不应纳入版本库，也不应手工修改构建快照。

## 测试与验证范围

在包目录设置测试解释器后执行构建和测试：

```powershell
# Windows PowerShell
$env:IFLY_TEST_PYTHON = 'C:\path\to\venv\Scripts\python.exe'
npm run check
```

```sh
# Linux/macOS shell
IFLY_TEST_PYTHON=/absolute/venv/bin/python npm run check
```

未设置 `IFLY_TEST_PYTHON` 时，测试通过 `python` 命令解析解释器；该解释器仍需安装 Python 依赖，包括读取本地音色数据时原模块所需的 `websocket-client`。`npm run typecheck` 仅检查 TypeScript，`npm test` 使用已构建的代码和 runtime；一般使用 `npm run check` 完成构建后再测试。

| 测试文件 | 覆盖范围 |
| --- | --- |
| `tests/package.test.mjs` | 凭证加载、节点注册路径、11 项 Skill 清单、脚本 staging 一致性与无效源保护 |
| `tests/execution.test.mjs` | 真实 Python 子进程、静态音色读取、协议错误、凭证隔离、binary helper、队列、超时/取消、进程树终止及资源清理 |
| `tests/adapters.test.mjs` | 真实 bridge 配合模拟 Skill 模块，覆盖翻译、校对、PDF 票据输入、TTS binary 返回及调用目录清理 |
| `tests/nodes.test.mjs` | 四个节点类的名称、版本、输入输出与凭证/操作元数据 |

默认测试使用本地数据和模拟响应，不调用收费 API。测试创建的临时目录由 fixture 和 Runner 回收。TTS adapter 测试中的音频为模拟字节，用于检查产物传递，不验证真实音频解码、合成质量或服务权限。

已完成 Windows 下的本地构建、离线测试、类型检查和 npm 打包清单检查。n8n helper 接线经过模拟上下文验证，四个业务节点尚未在 n8n 实例中完成端到端验收；真实 API 鉴权与业务结果、画布加载、错误分支及工作流行为不属于这些离线测试的结论。Linux/POSIX 终止分支、Python 最低版本及跨 worker 行为仍需在对应环境验证。

## 公共调用约定

`executeSkill(context, runner, itemIndex, operation)` 是节点使用的单 item helper；`nodes/common.ts` 负责创建 Runner，并按顺序处理多个 item。开发者也可直接调用已构建的 Runner；以下示例仅读取本地音色数据，仍需安装原模块依赖：

```javascript
const { PythonRunner } = require('./dist/shared/PythonRunner');

async function listVoices() {
  const runner = new PythonRunner({ pythonExecutable: '/absolute/venv/bin/python' });
  return runner.run(
    { skill: 'iflytek-hyper-tts', operation: 'listVoices' },
    async (response, files) => response,
  );
}
```

Windows 使用对应的解释器绝对路径。直接调用 Runner 的服务操作需通过请求中的 `credentials` 提供所需字段，Runner 再映射为子进程环境变量；凭证不进入业务 stdin JSON、脚本参数或临时配置文件。

- **协议：** 请求使用版本 1，包含 `requestId`、`input`、`parameters`；Runner 生成关联 ID。`input.files` 是保留字段，由公共层生成临时相对路径；直接调用方使用 `files`，n8n 接入使用 `binaryInputs`。
- **结果：** 成功须满足单个 UTF-8 JSON、匹配的版本/requestId、退出码 0 和 `ok: true`。公共层支持带 `data.taskId` 的 `queued`/`running` 结果，但当前五个操作均按同步调用返回，未启用远端长任务操作。
- **文件：** 消费回调收到结构化响应及产物 Buffer；协议中的 `artifacts` 文件描述由 Runner 收集后移除。回调完成后才清理调用目录，n8n 可先通过 `prepareBinaryData` 完成持久化。
- **n8n 接线：** 公共 helper 使用 `getCredentials`、`getExecutionCancelSignal`、`getBinaryDataBuffer` 和 `prepareBinaryData`，将错误转换为带 itemIndex 的 `NodeOperationError`；已生成 requestId 时附带关联信息。
- **环境隔离：** 子进程只接收必要系统变量和操作要求的 `IFLY_*`，不继承宿主其他凭证、`PYTHONPATH`、`NODE_OPTIONS` 或代理配置。Python 以 `-I -B -u -X utf8` 启动，不生成字节码缓存。管理员代理/CA 扩展尚未提供。
- **错误处理：** bridge 直接调用模块函数，丢弃调用期间的普通 stdout/stderr 诊断。Runner 有界读取协议并丢弃原始 stderr，使用本地固定错误消息；缺失凭证、非法输入、运行环境缺失、协议失败、超时等有独立错误码。服务 adapter 的上游失败目前主要归为 `UPSTREAM_ERROR`，未完整细分各产品的鉴权、限流和业务错误码；不应据此推断具体服务权限。

## 执行限制与资源清理

| 项目 | 当前实现 |
| --- | --- |
| 子进程及等待队列 | 每 Node.js worker 共享最多 2 个执行槽、32 个等待项；超出报错 |
| 超时 | 默认 120 秒；Runner 配置范围 1～600000 毫秒，覆盖排队及 Runner 调用，超时后终止子进程 |
| stdout / stderr | 默认及最大值为 8 MiB / 256 KiB；Runner 可配置更低上限 |
| stdin | 1 MiB 上限；每次调用最多 16 个输入文件和 16 个输出产物 |
| binary | 每次输入/输出各默认 32 MiB；Runner 可配置至 64 MiB；n8n 读取 helper 自身的内存限制由宿主控制 |
| 输出产物 | 检查路径、链接、重复、空文件、大小和允许的 MIME；Hyper TTS 当前仅返回 `audio/mpeg` |
| 终止 | Windows 使用固定 `taskkill.exe /PID <数字> /T /F`；POSIX 使用独立进程组，先 TERM，250 毫秒后 KILL |
| 清理 | 正常、错误、超时、取消及 binary 持久化失败均回收本次调用目录；清理失败明确报错 |
| 重试 | 公共层不自动重试，包括限流、提交结果不明及超时 |

节点目前使用 Runner 默认资源限额；表中可配置值指代码级 `RunnerConfig`，没有对应的节点表单参数。多 worker 的进程槽独立计算，不构成跨实例的全局限流。

消费回调及 n8n binary helper 的 Promise 无法被公共层强行中断；它们完成后会检查取消/超时状态并清理。Runner 超时从其调用开始，不替代 n8n 凭证读取、binary 读取或宿主存储自身的超时设置。

进程清理覆盖受控的 Python 子进程树。宿主崩溃、进程被外部强杀或子进程主动逃离进程组时，无法保证完成回收。浏览器渲染隔离、跨进程活动任务注册和 TTL 清扫尚未实现；公共层不会删除其他调用的临时目录。

## 发布状态与兼容边界

本包采用 Apache-2.0 许可证，当前交付为源码和可构建的本地开发制品。发布前需完成目标自托管 n8n 实例验收、真实业务验证与制品检查，再调整版本及 `private` 设置。

`n8n-community-node-package` 关键词用于社区包识别；`n8n.nodes` 和 `n8n.credentials` 声明安装后应加载的编译文件。关键词本身不代表 npm 已发布、索引已收录、自动安装或 verified 审核通过。本包依赖本地 Python、文件系统及子进程，当前不声明 n8n Cloud 兼容性。
