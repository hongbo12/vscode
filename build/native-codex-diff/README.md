# 原生差异审阅的源码与兼容构建

功能源码维护在当前主仓库。补丁以官方 1.137.0 提交 `645f29cc3176500b4b5762ba887cf2a7f0ffdf2c` 为构建基线；主仓库继续保留 1.139.0，不需要切换分支或修改已安装的编辑器。

## 日常修改位置

- `src/vs/workbench/api/common/codexExternalEditBridge.ts`：插件事件、工作目录和手动审批。
- `src/vs/workbench/api/browser/mainThreadChatSessions.ts`：跨进程桥接和审阅会话注册。
- `src/vs/workbench/contrib/chat/browser/chatEditing/codexExternalEditReviewSession.ts`：修改前内容、保留、撤销、删除、新建和未保存内容保护。
- `src/vs/workbench/contrib/chat/browser/chatEditing/codexWorkspaceEditCapture.ts`：每轮开始前保存工作区文本基线，捕获通用工具和终端写文件的结果。
- 同目录的原生编辑器组件：显示和交互。
- `templates`：安装、验证、备份恢复脚本及包内说明。

不要编辑 `.build/native-codex-diff` 中自动生成的兼容源码或压缩产物。新增功能文件需要加入 `target.json` 中的文件清单。

## 一次构建并打包

先安装项目及构建工具的依赖。需要 Git(版本控制工具)、Node.js(脚本运行环境)、npm(软件包管理工具) 和 Windows PowerShell(微软命令行脚本环境)。

在仓库根目录运行：

```powershell
git fetch https://github.com/microsoft/vscode.git 645f29cc3176500b4b5762ba887cf2a7f0ffdf2c
node build/native-codex-diff/build.mjs all --official-app-dir 'D:\Microsoft VS Code\645f29cc31\resources\app'
```

也可使用仓库快捷命令 `npm run native-diff:package -- --official-app-dir 'D:\Microsoft VS Code\645f29cc31\resources\app'`。

命令读取当前工作区的源码内容，包含尚未提交的改动。它从 `target.json` 指定的开发基线提取功能差异，在独立的工作树上应用到官方 1.137.0，并使用该版本自身的锁文件安装构建依赖。发生合并冲突时停止，保留现场供检查。

构建以指定官方安装中的本地化文件为参考，保留旧消息编号；新增消息保留英文原文。目标版本或提交号不符、源码发生变化、产物被修改、哈希校验失败时停止打包。

产物位于 `dist/native-codex-diff/1.137.0-<源码哈希>-<打包工具哈希>/`，包含独立补丁目录和压缩包。根据指定的官方应用目录生成本机安装路径配置，重新安装时无需再次输入路径。打包命令会先执行包检查，以及临时安装副本上的安装、验证、重复安装和恢复测试。不会关闭或修改正在运行的编辑器。同一份产物已存在时停止，避免覆盖已有包。

也可分别执行 `prepare`(准备兼容源码)、`build`(编译) 和 `package`(打包)；后两个阶段仍需指定官方应用目录。源码变化后重新执行完整命令，不复用旧产物。

## 功能验证

```powershell
npm run transpile-client
.\scripts\test.bat --run src/vs/workbench/api/test/common/codexExternalEditBridge.test.ts --run src/vs/workbench/contrib/chat/test/browser/codexExternalEditReviewSession.test.ts
```

这些测试覆盖审批和实际文本模型、内存文件系统中的保留／撤销行为。安装测试不代替真实界面的点击验证。

升级官方目标版本时，需要更新 `target.json`、安装模板的版本限制，并重新验证兼容构建。开发基线用于提取本功能的完整修改，不能直接改成最新提交，否则已有功能可能从差异中消失。
