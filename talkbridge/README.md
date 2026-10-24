# 语间 kotoba · 中日面对面字幕 V0.2

两部安卓手机加入同一房间；房主手机放在两人之间持续收音。双方选择不同语言，上方显示对方发言（译文优先），下方显示己方发言（原文优先）。按语言映射上下区域，不做人声身份识别。第一版不自动朗读。

## 当前状态

- 可运行：中日界面、房间码与二维码、直接加入、双端字幕同步、临时/最终字幕、字号、暂停/结束、断线暂停、会话上限。
- 无服务密钥时：仅演示。首页“先体验字幕演示”为本机示例；“创建对话”创建真实同步的双人演示房间。示例字幕明确标识，不采集声音、不冒充真实翻译。
- 2026-10-24 已接入真实服务：Speech Korea Central F0、Translator Global F0。Speech 临时授权和 Translator 中→日、日→中请求均返回 HTTP 200；中文合成 WAV 经真实 Speech 持续语言识别返回中文文字与 `zh-CN`。已部署后端的临时双人房间也验证了两句真实译文同步和结束清理。
- 2026-10-25 用户确认 V0.1 已在真机使用，并反馈字幕慢、加入步骤多、页面卡住后难以恢复。V0.2 针对这些问题改进；新版在不同安卓设备上的延迟、锁屏行为与长时间授权续期仍需复测。

字幕停止更新时，先点“重新连接”：房主会停止旧收音并主动建立新语音连接，来宾会重新获取房间状态。仍无法恢复时可点“刷新恢复”；两者都保留当前房间身份。主动“退出当前会话”会清除本轮字幕，请勿用它代替重连。

## 启动本地预览

需要 Node.js 22.13+（本次使用 24）。当前工作目录已安装依赖并初始化本地数据库，再次启动只需：

```powershell
cd 'C:\Users\ASUS\.codex\worktrees\ae50\AI_Project_2026_0\talkbridge'
npm run dev -- --port 5173
```

打开终端显示的 `http://127.0.0.1:5173/`。同一电脑可以用两个标签页测试，参与者会话只保存在各标签页的 sessionStorage。同一房间的邀请链接刷新后恢复现有身份；不同房间的邀请不会继承原房间身份。

**新检出目录的第一次启动**：先 `npm ci`，再 `npm run build`，然后执行以下迁移命令一次；不要在已经初始化的本地数据库上重复执行。

```powershell
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_confused_black_panther.sql
npm run dev -- --port 5173
```

`127.0.0.1` 只代表当前电脑，手机不能用它访问电脑。本地预览不是手机 HTTPS 部署；不要把电脑的普通 HTTP 局域网地址当作手机麦克风测试环境。安卓真实测试请使用已部署的 HTTPS 地址。

## 两台手机测试演示

1. 两部安卓 Chrome 打开同一 HTTPS 站点。
2. 第一台选择中文、演示模式，点击创建对话。
3. 第二台扫码或输入房间码，选择日本語，申请加入。
4. 第二人凭房间码直接加入，房主点击开始，无需再次批准。
5. 两端会看到同一组中日示例字幕。每句先出现临时文字，再以同一句编号更新为最终文字；日语用户的上下区域与中文用户相反。
6. 任一方暂停，双方停止演示；房主可继续。结束会话会清除字幕。刷新恢复保留当前身份与已确认字幕，房主恢复后主动点击继续收音。

站点访问权限由 Sites 独立管理：私有站点仍需获授权账号登录；所有者选择公开访问后，访客才可免 ChatGPT 登录。房间码是加入凭证，拿到它的第二人可直接加入，无需房主再次批准；不要把正在使用的房间码发给无关的人。每个房间最多两人，长期 Azure 密钥始终只保存在服务端。

## 配置真实翻译

1. 在 Azure 创建 Speech 资源以及 Translator 资源，记下各自的密钥和区域。请自行选择订阅与费用额度，本项目不替你创建付费资源。
2. 仅在服务端设置：`AZURE_SPEECH_KEY`、`AZURE_SPEECH_REGION`、`AZURE_TRANSLATOR_KEY`、`AZURE_TRANSLATOR_REGION`。区域必须来自各自资源，不能直接照抄示例。Translator 单服务资源若选择 Global，填写 `AZURE_TRANSLATOR_REGION=global`，程序会省略翻译请求的区域标头；区域资源则填写其实际区域代码。
3. 本地调试可将 `azure-config.example.txt` 的四个变量复制到项目根目录 `.dev.vars` 并填写真实值，然后重启开发服务。`.dev.vars` 已被 Git 忽略。**不要把密钥提交到代码、填进网页或发到聊天里。**
4. 托管站点应通过 Sites 的运行时环境变量/秘密配置入口设置同名值，不修改 `.openai/hosting.json`。保存环境变量后按平台要求重新部署，并刷新 `/api/config` 检查 `speechReady`。
5. `speechReady=true` 只表示变量存在且区域格式可用，并不证明凭据有效。需要创建真实模式房间、两端加入、允许麦克风后完成一次真实中日测试。

浏览器拿到约十分钟有效的 Speech 临时授权，长期密钥留在服务端；约八分钟更新一次。浏览器使用 Azure Speech JS SDK 的 `SpeechRecognizer` 和 continuous LID（中文 `zh-CN` / 日语 `ja-JP`），识别文本再由后端调用 Translator（中文 `zh-Hans` / 日语 `ja`）。JS continuous LID 不直接使用 TranslationRecognizer。SDK在需要收音时才加载。

参考官方文档：

- [持续语言识别与支持的 SDK](https://learn.microsoft.com/azure/cognitive-services/speech-service/language-identification)
- [语音语言支持](https://learn.microsoft.com/azure/ai-services/speech-service/language-support)
- [Translator 文本翻译](https://learn.microsoft.com/azure/ai-services/translator/text-translation/reference/v3/translate)

## 收音、隐私和异常边界

- 房间只有房主收音，双方轮流说中文或日语；语言不等于人声身份，不保证同句混说、重叠发言和嘈杂环境准确。
- 不保存原始音频。真实模式音频发送给 Azure Speech；文字发送给 Azure Translator。服务商数据处理与费用规则需要另行核对。
- 运行中双端同步查询间隔由 1.2 秒缩短为 0.6 秒，空闲时降低查询频率。临时字幕发送与翻译节流由 1.5 秒缩短为 0.7 秒，最终句立即提交。间隔不等于端到端延迟，实际速度还受 Azure 识别、翻译和网络耗时影响。
- 房间最长 30 分钟、最多 400 句；任一端约 20 秒无心跳，下一次认证请求会将会话暂停。房主重新开始才能恢复。
- 主动暂停或断线暂停会移除尚未确定的临时字幕，保留最终原文。已经确定但仍在等待翻译的句子会标为翻译失败，避免一直显示“翻译中”；不会把旧请求的译文写入恢复后的会话。
- 收音端切到后台主动停止麦克风；刷新页面恢复旧会话时先暂停。页面持续显示暂停/连接状态，不承诺后台收音。
- 同一标签页的会话身份与当前字幕快照暂存在 `sessionStorage`，仅内容变化时更新，用于刷新恢复；主动退出会清除本地缓存。其他端结束或房间过期后，离线页面需重新联网才能同步清理状态。此缓存不提供长期历史记录。
- 页面请求屏幕常亮，但系统可能拒绝或释放；请保持屏幕亮着和页面前台。
- 结束会话立即删除字幕。超时房间对外不可访问，物理记录由后续清理请求删除；不承诺无人访问时在到期瞬间删除。D1提供共享临时存储，默认不提供历史记录。没有原始录音保存。
- 房间成员使用独立随机会话令牌，服务器只保存令牌哈希；知道站点网址不能读取其他房间字幕。房间码允许第二人换取该房间的来宾令牌，只有房主可以收音和获取短期语音授权。

## 检查与验收

```powershell
npx tsc --noEmit
node --experimental-test-module-mocks --test tests/speech.test.ts
node --experimental-vm-modules --test tests/page.test.mjs
node --experimental-vm-modules --test tests/translator.test.mjs
node tests/api.mjs http://127.0.0.1:5173
```

API测试应只对隔离的本地预览运行，会创建和结束测试房间。创建限频为每身份/来源 12 次/小时，反复运行可能触发 429；不要为通过测试取消生产限频。

实机验收：两部安卓在安静环境下连续使用15分钟、20轮中日往返。逐条检查否定、数字、时间、人名；记录漏句、重复、语言误判，以及停止说话到最终译文的等待时间。还需测试拒绝权限、刷新、切后台、断网恢复、暂停结束后麦克风确实关闭。没有服务凭据前这些项目均不能视为通过。

## 文件入口

- `app/page.tsx` / `app/globals.css`：界面、双端状态与字幕上下分区。
- `lib/speech.ts`：浏览器持续语音识别、取消与麦克风释放。
- `lib/server.ts` / `app/api/`：房间权限、字幕版本、演示、授权和翻译接口。
- `db/schema.ts` / `drizzle/`：共享数据结构与迁移。
- `tests/`：可运行的核心检查。
