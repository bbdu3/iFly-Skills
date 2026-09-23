# n8n-nodes-iflytek

`n8n-nodes-iflytek` 将 iFly-Skills 仓库中的可复用能力封装为自托管 n8n 社区节点。每个已启用 Skill 对应一个节点，共享 `IflyApi` 凭证，通过 Node.js `child_process.spawn` 启动受控的 Python bridge；bridge 再加载随包分发的 Skill 脚本并返回稳定的 JSON 结果。

当前版本为 `0.0.0-dev.0`，`package.json` 仍设置为 `private: true`，用于开发和离线验收，尚未发布 npm。包元数据包含 `n8n-community-node-package` 关键字和 n8n 节点注册路径；关键字本身不代表已经发布或通过 n8n 审核。

## 已启用节点

| 节点 | 操作 | 输入 | 结果 |
| --- | --- | --- | --- |
| `IflyTranslate` | `translate` | 文本或 UTF-8 binary、源语言、目标语言 | `data.sourceText`、`translatedText`、语言字段 |
| `IflyTextProofread` | `check` | 文本或 UTF-8 binary | `data.result` 中的校对服务结果 |
| `IflyOcrInvoice` | `recognize` | 发票、收据等图片或 PDF binary | `data.result` 中的结构化识别结果 |
| `IflyHyperTts` | `synthesize` | 文本或 UTF-8 binary、音色和声音参数 | `data` 中的合成信息及 `binary.audio` MP3 |
| `IflyHyperTts` | `listVoices` | 无业务输入 | 随包静态音色常量；不访问服务端 |
| `IflyPdfImageOcr` | `recognizeImage` | 图片 binary、结果格式 | `data.result` 中的通用图片 OCR 结果 |
| `IflyPdfImageOcr` | `createPdfTask` | PDF binary 或公开 HTTP(S) URL、导出格式 | `data.taskNo`、任务状态及原始响应 |
| `IflyPdfImageOcr` | `getPdfTask` | PDF OCR `taskNo` | 当前状态及原始响应 |
| `IflyPdfImageOcr` | `getResult` | PDF OCR `taskNo` | 状态、完成标记和原始响应 |
| `IflySpeedTranscription` | `createTask` | MP3 binary、语言、口音和领域 | `data.taskId`、上传地址 |
| `IflySpeedTranscription` | `getTask` | 转写 `taskId` | 当前状态及原始响应 |
| `IflySpeedTranscription` | `getResult` | 转写 `taskId` | `data.text`、分段、状态和原始响应 |
| `IflyImageUnderstanding` | `analyze` | 图片 binary、问题和模型参数 | `data.text` |
| `IflyVideoTranslate` | `createTask` | 公开视频 HTTP(S) URL、源语言、目标语言 | `data.result` 中的任务信息 |
| `IflyVideoTranslate` | `listTasks` | 无业务输入 | `data.result` 中的任务列表 |
| `IflyVideoTranslate` | `getTask` | 视频翻译 `taskId` | `data.taskId` 及任务详情 |
| `IflyVideoTranslate` | `confirmTranscript` | 视频翻译 `taskId`、是否强制重跑 | `data.result` 中的确认结果 |
| `IflyVoicecloneTts` | `getTrainingText` | 训练文本集 ID | `data.result` 中的文本片段 |
| `IflyVoicecloneTts` | `createTraining` | 任务名称、性别、引擎和语言 | `data.result` 中的训练任务 |
| `IflyVoicecloneTts` | `uploadSample` | 训练任务 ID、音频 binary 或 URL、文本片段 | `data.result` 中的上传结果 |
| `IflyVoicecloneTts` | `submitTraining` | 训练任务 ID | `data.result` 中的提交结果 |
| `IflyVoicecloneTts` | `getTraining` | 训练任务 ID | 状态、资源 ID 和原始响应 |
| `IflyVoicecloneTts` | `synthesize` | 文本、克隆资源 ID 和声音参数 | `binary.audio` 及合成信息 |

当前共 9 个节点、23 个操作。合同审核和 Animated Sketch Diagram 没有注册为可执行节点：合同审核仍缺少完整的内部客户端，Animated Sketch Diagram 需要未随包分发的渲染资源及浏览器/ffmpeg 依赖。票据 OCR 与通用 PDF/图片 OCR 是两个独立节点，不能互相替代。

## 运行结构

```text
n8n node
  -> executeSkill
  -> PythonRunner
  -> child_process.spawn(python -I -B -u -X utf8)
  -> runtime/bridge/bridge.py
  -> one allow-listed Skill module
  -> JSON response and optional binary artifacts
```

`runtime/` 在构建或打包时由 `skills.json` 和仓库 `skills/` 生成，不手工维护第二份业务脚本。bridge 只接受 `operations.json` 中登记的固定 skill/operation，丢弃 Skill 的 stdout/stderr，并将上游异常转换为固定错误码。每次调用使用独立临时目录，输入 binary 由 n8n helper 写入，输出在持久化完成后回收。

请求协议使用版本 `1`，包含 `requestId`、`input` 和 `parameters`。成功结果包含 `ok: true`、`status: succeeded`、`data`、`artifacts` 和执行耗时；节点输出会保留 `pairedItem`。默认错误会终止当前节点，开启 n8n 的 continue-on-fail 后才会按 item 写入 `json.error`。

## 凭证与配置

在 n8n 中创建一个 **iFlytek API** 凭证（内部名 `iflyApi`），各节点按操作需要复用：

| n8n 字段 | Python 子进程变量 |
| --- | --- |
| `appId` | `IFLY_APP_ID` |
| `apiKey` | `IFLY_API_KEY` |
| `apiSecret` | `IFLY_API_SECRET` |

翻译、校对、票据 OCR、Hyper TTS、图片 OCR、极速转写、图片理解和声音克隆合成使用完整三元组。PDF OCR 的创建和查询只需要 `appId` 与 `apiSecret`；视频翻译只需要 `apiKey` 与 `apiSecret`；声音克隆训练只需要 `appId` 与 `apiKey`。执行层按操作注入凭证，不会将无关字段传给子进程。`listVoices` 不需要凭证，也不能用来验证账户权限或真实合成能力。子进程不会继承主机中的 `XFEI_*`、`XFYUN_*`、`PYTHONPATH`、`NODE_OPTIONS` 或其他未列入白名单的变量。

管理员需要在 n8n 进程环境中配置 Python 解释器的绝对路径：

```powershell
$env:IFLYTEK_PYTHON_EXECUTABLE = 'C:\path\to\venv\Scripts\python.exe'
$env:IFLYTEK_TMP_ROOT = 'C:\path\to\existing-temp-directory' # 可选
```

Linux/macOS 使用对应的 `/absolute/venv/bin/python` 路径。Python 依赖由管理员按 `python/requirements-core.lock` 安装；节点执行和 npm 安装不会自动运行 pip。`IFLY_TEST_PYTHON` 仅供测试脚本选择解释器，不参与节点运行配置。

## 节点输入约定

- 文本节点接受直接文本或指定的 UTF-8 binary 字段；两者同时提供时使用直接文本。
- 图片 OCR、票据 OCR、图片理解和 PDF 任务使用 n8n binary 字段，不接受本地文件路径。PDF 创建任务也可以使用公开的 HTTP(S) URL。
- 极速转写当前按 MP3 任务接口提交；bridge 会在调用目录中使用 `.mp3` 临时扩展名，目录在调用结束后删除。
- PDF `getPdfTask` 与 `getResult` 都查询任务状态。完成状态为 `FINISH` 或 `ANY_FAILED` 时，`getResult` 返回完成标记；下载地址仍由服务响应提供，节点不会擅自下载或改写外部文件。
- Hyper TTS 合成输出默认写入 `binary.audio`，文件名为 `speech.mp3`；`listVoices` 只读取随包的常量。
- 图片理解支持 `general`/`imagev3`、`temperature` `(0, 1]` 和 `maxTokens` `1..8192`。原始 WebSocket 帧不会暴露给 n8n。
- 视频翻译使用公开视频 URL，不在节点内上传本地视频；`confirmTranscript` 单独执行确认，并通过 `forceRerun` 明确控制后续重跑，不自动重试任务提交。
- 声音克隆训练拆分为获取训练文本、创建任务、上传样本、提交和查询状态；上传样本可使用 binary 或公开 URL，二者必须二选一。合成需要已训练的 `resId`，输出支持 MP3、PCM、Speex 和 Opus。

## 安装、构建与打包

开发环境需要 Node.js 24、npm、Git 和 Python 3.10 或更高版本。`n8n-workflow` peer 依赖范围为 `>=2.39.3 <3`。

```sh
cd packages/n8n-nodes-iflytek
npm ci
<venv-python> -m pip install -r python/requirements-core.lock
<venv-python> -m pip check
npm run check
npm pack --dry-run
```

`npm run build` 会清理并重新生成 `dist/`，编译凭证、节点和共享执行层，再按白名单生成 `runtime/bridge`、`runtime/skills`、依赖锁定文件和 `runtime/manifest.json`。`npm pack` 通过 `prepack` 重建后，只将 `dist/`、`runtime/`、README、LICENSE 和包元数据纳入制品；测试、源代码、构建脚本和 `node_modules/` 不进入制品。

## 测试与边界

```powershell
$env:IFLY_TEST_PYTHON = 'C:\path\to\venv\Scripts\python.exe'
npm run check
npm run typecheck
npm pack --dry-run
git diff --check
```

测试使用本地 fixture 和模拟 Skill 模块，不调用真实服务或输出真实凭证，覆盖 bridge adapter、三元组/部分凭证隔离、binary 输入输出、协议错误、取消和超时、临时目录回收、节点元数据、运行资源 staging 及制品清单。临时目录、tarball、`.pyc` 和测试缓存不应提交；`dist/`、`runtime/`、`node_modules/` 是可重建或开发目录，保持 Git 忽略即可。

真实 n8n 实例兼容性、服务端权限与配额、业务识别质量、发布版本管理和 npm 发布不属于当前开发包的离线测试结论。

## 许可

本包使用 Apache-2.0 许可证，详见 [LICENSE](LICENSE)。
