# 语间 Kotoba · 远程与面对面四语字幕 V0.7

## V0.7 远程双人

验证：101项自动化测试、TypeScript及本地API检查通过；窄屏检查了远程创建、邀请直接加入、双端控制与刷新恢复。测试覆盖权限拒绝/采集释放、迟到请求隔离、单端暂停和原有模式回归；仍需两位用户在各自真实设备上验收。

首页创建房间时选择“远程双人”，选好自己实际说的语言；朋友通过邀请链接或房间码加入，并选择自己的语言。双方各点一次开麦并允许本机麦克风，之后可连续说话，无需一直按按钮。每人固定识别自己的语言，原文和译文同步到双方页面：上方对方、下方自己。支持中、英、日、韩中两种不同语言。

- 双方有各自的收音、暂停、重连状态。暂停、刷新或后台停麦只影响本人；返回后需主动重新开麦，不会因为对方正在说话而自动启动本机麦克风。离开房间或结束对话会停止本轮双方收音。
- 临时文字更新同一行，最终原文支持本人纠错。服务端校验身份、本人语言及本轮录音世代，不能替对方发字幕；旧录音的延迟请求不能写入新一轮收音。
- 原有“双手机面对面”仍由房主一部手机收双方声音；`/solo` 单手机分屏和 `/meeting` 会议翻译保持原入口。已有房间不会因升级自动变为远程房间。
- 远程模式只传字幕；每端音频送 Azure 识别，**不向对方播放原声，也不是音视频通话**。若同时使用其他通话软件，建议戴耳机，避免麦克风又收到对方外放声。
- 免登录和房间码直接加入保持不变。每房间仍为30分钟、最多400条；不保存录音，结束清除字幕。两路同时开启会分别产生语音用量，静音但未暂停也可能计入；本版未实现全站每月8小时硬限额。

两个麦克风需要两路并发识别。Azure 官方当前列出的 Speech F0 实时识别并发上限为1，S0默认100；套餐切换后的并发配额可能需要数小时生效。实际资源能力须用双路测试验证，不能凭配置存在判断。[Azure Speech 配额](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)

```powershell
# 完整自动化命令仍见下方；额外真实双路测试需明确 --live，会产生少量Azure用量。
node tests/live-remote.mjs http://127.0.0.1:5173 --live
```

真实服务脚本验证并发语音识别、双向翻译和同房间同步；不等于已验证朋友所在地的网络、真实安卓麦克风或长时间后台行为。

2026-10-26 本地真实云端验证通过：两个独立识别流在同时活动时均收到最终文字；中文“你好，今天学习神经网络。”译为“Hello, today we are learning about neural networks.”，英文“Today we study neural networks.”译为“今天我们研究神经网络。”，双方查询看到同一批最终字幕。暂停中文端后，原英文连接继续识别、翻译并同步，结束后清空临时房间。本次并发成功不用于推断Azure实际SKU；没有更改套餐。

本版修改：`app/page.tsx`、`app/globals.css`、`lib/ui-copy.ts`（模式入口及双方独立控制）；`lib/server.ts`、`lib/types.ts`、`db/schema.ts`、`drizzle/0003_melted_captain_marvel.sql`及迁移元数据（独立状态与权限）；`lib/speech.ts`（英语故障提示）；`tests/page.test.mjs`、`tests/translator.test.mjs`、`tests/speech.test.ts`、`tests/live-remote.mjs`（回归与真实双路检查）；页面元数据、版本及配置说明。没有新增依赖。

## 视频会议双向翻译

打开 `/meeting`。首版面向 **Windows 桌面 Chrome / Edge**，复用现有 Azure Speech、Translator、私有单端房间及字幕版本控制；没有增加服务依赖或数据库迁移。现有面对面页面也可选择英语。

1. **听老师**：选择“听老师：英语 → 中文”，点开始。在浏览器弹窗中优先选择正在播放授课声音的会议标签页，并打开“共享标签页音频”。桌面会议软件可尝试共享整个屏幕及系统声音，实际选项以浏览器为准。窗口共享不一定提供音轨。
2. **我发言**：选择“我发言：中文 → 英语”，再点开始并允许麦克风。切换会关闭前一音源，不自动继续授权。每段固定源语言识别，不需要语言自动检测或说话人分离。
3. 临时文字在同一条字幕中更新；句子确认后保留最终原文与译文。暂停、停止后可滚动查看、复制本页记录。刷新或关闭页面不恢复会议记录，请先复制需要保留的内容。
4. 英文译文完成后可手动“本机播放英文”。使用浏览器/系统提供的英文语音；若设备没有英文声音会提示安装或切换浏览器。播放前先关闭采集，播完需手动开始，避免把译音再次识别。

电脑音频模式仅消费用户授权的共享音轨，不主动打开或混入麦克风。共享屏幕 API 要求附带视频轨，但视频不上传、不识别；所有采集轨道在停止、切换或关闭页面时释放。无音轨、取消、权限拒绝和不支持的浏览器会显示原因，不显示正在翻译。建议选择具体会议标签页；共享系统声音会包含其他应用通知等声音。

会议页允许切换到会议标签页继续收音；关闭网页会停止。浏览器休眠、系统锁屏、网络中断仍可能中断，需要回到页面检查状态。沿用现有每房间 **30 分钟 / 400 条**上限；停止后可开始新房间，本页历史仍可复制。本次没有完成前一任务的 Speech S0 升级或每月 8 小时授权控制，不能将它们视为已启用。

### 本机朗读与会议麦克风

“本机播放英文”只代表浏览器播放成功，**不代表老师已经听到**。本版本没有把音频注入其他网站或桌面会议软件的麦克风。

Windows 可在后续通过 [VB-CABLE 官方虚拟音频设备](https://vb-audio.com/Cable/) 或混音器实现：将 Kotoba 所在浏览器的输出路由到 `CABLE Input`，会议软件麦克风选择 `CABLE Output`，会议扬声器保持耳机；如需同时传原声，需要额外混音。浏览器语音合成没有可移植的输出设备选择接口，通常需 Windows 音量混合器/应用路由；部分系统语音走系统默认输出，应先用会议“麦克风测试”确认。网页会议与 Kotoba 使用同一浏览器进程时可能共享输出路由，建议分用浏览器/桌面会议客户端，避免老师声音回传。本版不安装驱动、不修改系统音频路由，不承诺会议端效果。

### 验证命令与边界

```powershell
node node_modules/typescript/bin/tsc --noEmit
node --experimental-test-module-mocks --test tests/speech.test.ts tests/audio-capture.test.ts
node --experimental-vm-modules --test tests/page.test.mjs tests/solo-page.test.mjs tests/translator.test.mjs tests/meeting-page.test.mjs
# 显式运行真实云端测试，产生少量 Azure 用量（约20秒合成语音）：
node tests/live-meeting.mjs http://127.0.0.1:5173 --live
```

自动测试检查源切换、取消/无音轨、资源释放、临时/最终字幕去重及播放前停止采集。真实服务脚本通过合成英/中文音频验证 Speech → 字幕 API → Translator；不能代替共享选择框、实际授课声音、真人口音、长课及会议对方收音验收。具体本地启动和首次数据库初始化见下方。

2026-10-25 验证：85 项自动测试通过；真实 Azure 合成语音链路得到 “Today we will learn about neural networks.” → “今天我们将学习神经网络。”，以及 “老师，请再解释一下这个问题，谢谢。” → “Teacher, please explain this issue again, thank you.”。桌面和390px窄屏检查了页面布局、模式切换和语言交换，未出现横向溢出。自动化浏览器没有提供可操作的系统共享选择框，因此真实标签页音轨采集、系统音频、真人麦克风和会议对方听到英文尚未验收。

本版文件：`app/meeting/page.tsx`、`app/meeting/meeting.css`（新页面）；`lib/audio-capture.ts`、`lib/speech.ts`（采集与固定语言识别）；`lib/types.ts`、`lib/languages.ts`、`lib/ui-copy.ts`、`lib/server.ts`（英语、翻译与授权检查）；`app/page.tsx`、`app/solo/page.tsx`、`app/globals.css`、`app/layout.tsx`（原页面入口和四语言显示）；`tests/meeting-page.test.mjs`、`tests/audio-capture.test.ts`、`tests/live-meeting.mjs`、`tests/speech.test.ts`、`tests/translator.test.mjs`、`tests/api.mjs`（验证）；`package.json`、`package-lock.json`、`public/SETUP.html` 与本说明（版本、使用文档）。

浏览器依据：[共享音频与用户手势限制](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)、[Chrome 共享选项](https://developer.chrome.com/docs/web-platform/screen-sharing-controls)、[系统语音列表](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices)。音频仍发往 Azure Speech，文字发往 Translator；长期服务密钥保留在服务器。原站点继续免登录。

支持单台安卓面对面使用，以及原有两部手机共享房间。双手机模式仍按语言分区；单手机模式使用匿名说话人标签区分 A/B。只显示字幕，不自动朗读。

## V0.5 单手机面对面

从首页进入 `/solo`，选择 A、B 各自希望阅读的语言，再开始。单机指一台手机联网使用，音频仍由 Azure 处理，不是离线识别。

- 手机放在两人之间：下半屏面向 A，显示 B 的话；上半屏面向 B，显示 A 的话，默认旋转 180°，可切回正向。各自优先看翻译，原文在下方。
- 使用 `ConversationTranscriber` 返回的匿名说话人标签，而非按语言猜测人。每次开始、继续或重连，都请 A 先完整说一句，再由 B 说。标签只在本次语音连接中有效，不保存声纹或跨会话身份。
- 首次出现的声音只在最终结果时分配 A/B；尚未确定或额外声音先列入未确定区域，不擅自归属，也不自动翻译。可在最终字幕中修改 A/B 归属，系统重新计算目标语言及译文。
- 双方可使用所选语言对中的任一语言；目标始终是另一方的阅读语言。双方选择同一语言时保留人声分区，原文直接显示，不发起相同语言的翻译请求。
- 双方已完成的原文都可纠错。单手机会话不等待另一台设备、不提供分享加入；刷新后恢复已确认字幕，需手动继续收音。切后台停止麦克风。
- 2026-10-25 已用现有 Korea Central 资源验证说话人标签；已有中文/日文两种合成声音连续两轮得到稳定的 Guest-1/Guest-2 和语言结果。未改变订阅层级。此结果不代表两名真人、同语言双人、同一人切换语言或中韩安卓实测已经通过。

真机验收建议：先在安静环境轮流说话，检查 A/B 归属、数字时间、原文纠错、归属纠错、旋转、刷新恢复和后台停麦。语音标签可能暂时未知或判断错误，同时讲话和噪声会降低准确度。

V0.3 支持中文↔日语、中文↔韩语、日语↔韩语。每个房间仍是两人、两种固定语言，识别器只检测本房间语言对。原站点维持公开访问，无需 ChatGPT 登录。

## V0.4 字幕响应与连接诊断

用户已确认 V0.3 安卓实测无异常。本版保留三语言、原文纠错、免登录和刷新恢复，优化已有字幕链路：

- 收音端先显示识别到的本机原文草稿，不必等翻译响应。草稿未确认同步时不开放纠错、不写入恢复缓存；停止收音、识别无匹配或发送失败时清除。
- 同一句的最终原文与已翻译临时原文完全相同，且语言与会话一致时复用该句译文。原文改变、翻译失败、不同句或用户已纠错时，不复用旧译文。
- 连续存在声音且约 12 秒没有识别活动时提示可能停更；需满足足够的实际声音采样。正常安静、识别恢复和停止收音会清除提示。环境噪声也可能触发提示，不据此自动暂停或重启麦克风。
- 显示设置中可展开诊断，查看本次连接的语言确认等待、翻译服务耗时、字幕请求往返和房间查询往返。语言确认等待从首次识别文字出现开始，未包含说话到文字出现的时间；其余项目分别测量各自区间，不能相加当作端到端延迟。
- 复用译文明确标记为复用，不作为一次 0 毫秒的 Azure 调用。演示模式不产生真实语音/翻译耗时。诊断只保留在当前页面内存，不上传遥测或保存音频。

语音识别和翻译的实际速度仍受手机、网络和云端影响；本版不承诺固定的端到端延迟。

## 原文纠错

双手机模式下，在下方“我说的话”中，点击已完成字幕的“修改”，编辑原文后选择“保存并重新翻译”。每人只可修改自己所选语言的字幕，正在识别的临时字幕不可编辑；房主没有修改另一方语言字幕的额外权限。单手机模式允许操作者修改双方原文及本句 A/B 归属。

- 保存后双端更新同一条字幕，标记“已修改”。旧译文立即清空；失败时保留新原文并提供“重试翻译”。
- 保存请求失败保留编辑输入。空白文字不能保存，原文最长 1000 个字符；未修改时关闭编辑，不调用翻译。
- 暂停期间仍可纠错，结束后不可修改。文字归属语言不能在纠错中更改。
- 修订号与服务端权限检查阻止旧译文、晚到识别结果、旧参与者请求覆盖新原文。
- 房间演示可练习纠错，但译文明确标注演示占位，不调用真实翻译服务。
- 编辑不产生永久历史；房间结束后的清理规则不变。

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
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_purple_raider.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_third_ikaris.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0003_melted_captain_marvel.sql
npm run dev -- --port 5173
```

已有 V0.2 本地数据库升级时，只执行尚未应用的 `0001_purple_raider.sql` 一次；该迁移只添加默认值为 0 的 `edited` 列。线上由 Sites 发布流程自动应用增量迁移，勿重放旧迁移。

已有 V0.4 本地数据库只需执行尚未应用的 `0002_third_ikaris.sql` 一次，添加设备模式、说话人及目标语言字段。

已有V0.6本地数据库只执行尚未应用的 `0003_melted_captain_marvel.sql` 一次，添加双方独立收音状态及世代。当前工作目录已执行；线上由发布流程应用。

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

浏览器拿到约十分钟有效的 Speech 临时授权，长期密钥留在服务端；约八分钟更新一次。浏览器使用 Azure Speech JS SDK 的 `SpeechRecognizer` 和 continuous LID（中文 `zh-CN` / 日语 `ja-JP` / 韩语 `ko-KR`，每次只选房间内两种），识别文本再由后端调用 Translator（中文 `zh-Hans` / 日语 `ja` / 韩语 `ko`），目标为另一位参与者的语言。JS continuous LID 不直接使用 TranslationRecognizer。SDK在需要收音时才加载。

参考官方文档：

- [持续语言识别与支持的 SDK](https://learn.microsoft.com/azure/cognitive-services/speech-service/language-identification)
- [语音语言支持](https://learn.microsoft.com/azure/ai-services/speech-service/language-support)
- [Translator 文本翻译](https://learn.microsoft.com/azure/ai-services/translator/text-translation/reference/v3/translate)

## 收音、隐私和异常边界

- 面对面房间只有房主收音，双方轮流说本房间选定的两种语言；远程房间双方各自收音，只识别本人的语言。语言不等于人声身份，不保证同句混说、重叠发言和嘈杂环境准确。
- 不保存原始音频。真实模式音频发送给 Azure Speech；文字发送给 Azure Translator。服务商数据处理与费用规则需要另行核对。
- 运行中双端同步查询间隔由 1.2 秒缩短为 0.6 秒，空闲时降低查询频率。临时字幕发送与翻译节流由 1.5 秒缩短为 0.7 秒，最终句立即提交。间隔不等于端到端延迟，实际速度还受 Azure 识别、翻译和网络耗时影响。
- 房间最长30分钟、最多400句；远程模式某端约20秒无心跳，下次认证仅暂停该端，另一端继续。面对面模式任一端离线会暂停全房间，房主重新开始才能恢复。
- 主动暂停或断线暂停会移除尚未确定的临时字幕，保留最终原文。已经确定但仍在等待翻译的句子会标为翻译失败，避免一直显示“翻译中”；不会把旧请求的译文写入恢复后的会话。
- 收音端切到后台主动停止麦克风；刷新页面恢复旧会话时先暂停。页面持续显示暂停/连接状态，不承诺后台收音。
- 同一标签页的会话身份与当前字幕快照暂存在 `sessionStorage`，仅内容变化时更新，用于刷新恢复；主动退出会清除本地缓存。其他端结束或房间过期后，离线页面需重新联网才能同步清理状态。此缓存不提供长期历史记录。
- 页面请求屏幕常亮，但系统可能拒绝或释放；请保持屏幕亮着和页面前台。
- 结束会话立即删除字幕。超时房间对外不可访问，物理记录由后续清理请求删除；不承诺无人访问时在到期瞬间删除。D1提供共享临时存储，默认不提供历史记录。没有原始录音保存。
- 房间成员使用独立随机会话令牌，服务器只保存令牌哈希；知道站点网址不能读取其他房间字幕。房间码允许第二人换取该房间的来宾令牌；面对面模式只有房主可以收音，远程模式双方分别获取自己的短期语音授权。

## 检查与验收

2026-10-25 V0.5 发布前验证：64 项自动化检查及 TypeScript 检查通过；真实 Azure 中韩单机会话验证未知归属等待、分配后翻译、改归属重译、同语言直接原文、暂停纠错与结束清理。浏览器窄屏检查验证演示双区、180°旋转、纠错移动分区和刷新保留。真人声音与安卓麦克风效果仍需用户现场验收；合成声音兼容性测试不能代替真人测试。

2026-10-25 V0.4 发布前验证：51 项自动化检查及 TypeScript 检查通过；真实 Azure 接入验证了相同最终原文复用译文、纠错后重新翻译和日韩双端同步。停更/静音/计时器节流、原文草稿先显示与清理、过期回调隔离通过可复现的模拟测试。V0.3 已由用户确认真机无异常，V0.4 的安卓实际噪声阈值和端到端等待时间仍需现场复测。

2026-10-25 V0.3 发布前验证：41 项自动化回归检查、TypeScript 检查、本地 API 集成和浏览器双端纠错/刷新恢复通过。真实 Azure 测试通过六个翻译方向与六次原文修正重译；中韩、日韩合成音频连续识别均返回完整韩语时间地点句。浏览器检查包含窄屏编辑面板，但未替代两部安卓实体设备的麦克风和输入法验收。

```powershell
npx tsc --noEmit
node --experimental-test-module-mocks --test tests/speech.test.ts
node --experimental-vm-modules --test tests/page.test.mjs
node --experimental-vm-modules --test tests/solo-page.test.mjs
node --experimental-vm-modules --test tests/translator.test.mjs
node tests/api.mjs http://127.0.0.1:5173
```

API测试应只对隔离的本地预览运行，会创建和结束测试房间。创建限频为每身份/来源 12 次/小时，反复运行可能触发 429；不要为通过测试取消生产限频。

实机验收：两部安卓在安静环境下连续使用15分钟，分别测试中日、中韩、日韩双向发言。逐条检查否定、数字、时间、人名；记录漏句、重复、语言误判，以及停止说话到最终译文的等待时间。测试原文纠错时的中文、日文、韩文输入法、键盘遮挡、双端同步与刷新恢复。还需测试拒绝权限、切后台、断网恢复、暂停结束后麦克风确实关闭。合成音频或桌面浏览器验证不等于安卓真机验收。

## 文件入口

- `app/page.tsx` / `app/globals.css`：界面、双端状态与字幕上下分区。
- `lib/speech.ts`：浏览器持续语音识别、取消与麦克风释放。
- `lib/server.ts` / `app/api/`：房间权限、字幕版本、演示、授权和翻译接口。
- `db/schema.ts` / `drizzle/`：共享数据结构与迁移。
- `tests/`：可运行的核心检查。
