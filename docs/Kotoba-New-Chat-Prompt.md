# Kotoba 新聊天启动提示词

把下面代码块完整复制到新聊天。若新聊天不能访问本机文件，同时附上 [完整交接文档](Kotoba-V0.7-Handoff.md)，或提供 [GitHub main 中的文档](https://github.com/SHI-0721/AI_Project_2026_2/blob/main/docs/Kotoba-V0.7-Handoff.md)。不要附带 `.dev.vars` 或服务密钥。

```text
请接手现有 Kotoba（语间／Talkbridge）V0.7 项目。先读取完整交接文档并检查实际代码，再按我接下来提出的任务继续，不要从零重做，也不要混淆成 Costudy。

本机外层 GitHub 仓库：
C:\Users\ASUS\.codex\worktrees\ae50\AI_Project_2026_0
应用目录：上述目录下的 talkbridge
完整交接文档：上述目录下的 docs\Kotoba-V0.7-Handoff.md
GitHub：https://github.com/SHI-0721/AI_Project_2026_2
线上网站：https://talkbridge-cn-ja-20261024.artfulzebra9.chatgpt.site

用户已要求把 V0.7 和交接材料合入 GitHub main。先 fetch 并核对当前分支／提交，不假定本机另一个检出 main 的工作目录已自动更新。已有外层 GitHub 仓库和内层 talkbridge Sites 源码仓库是两套发布流程；GitHub 合并不会自动部署网站。若本机路径不可用，先找到此仓库或从 GitHub 读取材料，不推断项目丢失。

截至 2026-10-27，线上是 Sites 保存版本9，对应产品V0.7，访问public、部署succeeded。项目ID在 talkbridge/.openai/hosting.json 中；复用已有站点，保留免登录。Sites源码提交 a4b4a0b22e489da7f3a8264f8df2826e44fd356b；GitHub应用提交803d336包含相同的应用文件，交接材料是后续提交。

现有能力：中、日、韩、英。首页包含 paired 双手机面对面（仅房主手机采集双方声音，按语言归属）与 remote 远程双人（各自开自己的麦克风，固定本人语言，独立启停与重连，同步原文和译文，不传通话声音）。/solo 是联网单手机匿名说话人A/B分屏，上半屏可旋转；/meeting 是麦克风或用户授权的电脑／标签页音轨，英→中听老师、中→英发言，以及本机英文朗读。会议页复用solo房间，不是第四种数据库deviceMode。

当前技术：React/TypeScript + Vinext/Vite + Sites Cloudflare Workers/D1 + Azure Speech JS SDK + 服务端Azure Translator。音频直达Speech，字幕API和D1同步文本。长期密钥仅服务端；禁止读取并输出真实密钥或把它们提交GitHub。

先读 lib/types.ts、lib/languages.ts，再读 app/page.tsx、app/solo/page.tsx、app/meeting/page.tsx，以及 lib/speech.ts、lib/audio-capture.ts、lib/server.ts、db/schema.ts、drizzle和tests。复用现有生命周期与版本保护，不增加另一套识别服务。remote有房间generation和双方独立captureGeneration；单端暂停不能打断对方。临时字幕同id修订，final原文手动纠错，不能让迟到回调覆盖新结果。

本次免费验证：tsc、101项自动测试、npm run build、git diff --check通过。发布时合成音频已验证实际Azure双路和线上字幕同步；两名异地用户真实安卓开麦、真实会议共享音轨、长时与后台行为仍需实际验收。原用户已确认旧版本真机可用，不代表V0.7全部真机验收通过。

边界：每房间创建起30分钟、最多400条；首页/solo切后台停麦，meeting允许切换会议标签页；刷新不自动开麦。会议本机朗读不代表音频送入会议麦克风。没有WebRTC通话、离线翻译、永久声纹、GPT自动纠错或长期历史。

之前讨论的Speech升级S0、Translator保持F0、学生余额、全站每月8小时控制不能写成已完成：云端实际SKU需复核，当前没有月度账本/额度硬限制，也没有按token expiresAt本地硬停止。用户预算目标是每月100元内；两端同时开麦分别累计语音用量。未经需要不要重复运行--live付费测试。

详细启动、数据库0000至0003迁移、测试、Sites发布步骤、现有限流、文案残留和后续建议都在完整交接文档。先简短确认你读到的实际状态，然后执行我下一条具体要求；不要自行开始全部路线图，不要重置其他工作树，不要恢复GPT登录，不要新建替代站点。
```
