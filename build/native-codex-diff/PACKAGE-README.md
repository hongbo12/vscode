# 原生代码差异审阅补丁

目标：VS Code(代码编辑器) 1.138.0，官方提交 `7debcd0e2acdea1c52de81bf9ee1620444407dda`。

补丁由当前源码库的功能改动应用到官方版本源码后重新构建。具体源码差异、修订标识和文件哈希记录在 `source-changes.patch`、`build-manifest.json` 和 `payload/product.json` 中。

主进程保留本机官方文件，仅将启动前加载的文件读取模块改为按原始文件读取，修复归档扩展名测试文件无法读取的问题。变换源码随包保存在 `runtime-patches.mjs`，输入文件和变换脚本的哈希记录在构建清单中。

## 安装

保存文件并完全退出编辑器，然后运行 `install-native-codex-inline-diff.bat`。安装程序会检查目标版本、签名、运行状态和载荷哈希，备份后安装，验证成功后重新启动编辑器。

标准安装目录会自动查找。自定义安装目录可在包根目录创建 `install-target.local.cmd`，例如：

```bat
@set "OFFICIAL_INSTALL_DIR=D:\Microsoft VS Code"
```

这个设置同样用于计划检查、验证和安装副本测试。复制到其他电脑时请修改或删除这个本机配置文件。

## 行为

- 插件发出的写入审批继续由用户选择；补丁不会自动发送同意。用户同意时，先确保修改前内容已捕获，再发送同意结果。
- 写入后通过原生编辑器显示增删，并逐块保留或撤销。
- 未保存内容发生冲突时保留用户缓冲区并显示错误，不自动覆盖。
- 支持新增、修改、删除及重命名的累计审阅。
- 每轮插件执行前保存整个工作区中搜索可见的文本文件基线，完成后再比较文件变化。通用执行工具和终端写文件也会产生原生审阅条目；既有文件的监听事件可在执行期间更新审阅。
- 遵循工作区的搜索排除和忽略文件规则，排除二进制文件；不会把依赖目录和已忽略的构建产物自动加入审阅。
- 同一窗口的工作区基线不允许多个对话同时执行，以免混淆修改来源。期间检测到人工编辑的文件会明确提示冲突并保留用户内容。

插件采用无需审批的策略时，补丁不会改写该策略；编辑器里的逐块保留／撤销与写入前审批是两个阶段。捕获基线失败时，该轮执行会停止并显示错误。已经完成的历史轮次没有事前基线，不能补生成精确的原生审阅块。

## 检查与恢复

```bat
install-native-codex-inline-diff.bat --plan
install-native-codex-inline-diff.bat --verify
install-native-codex-inline-diff.bat --test
```

安装副本测试只操作临时目录。真实界面的显示、点击和远程连接需另行验证。

备份路径会在安装时打印。退出编辑器后，可按实际备份路径恢复：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\patch-official-vscode.ps1 -Action Restore -BackupPath '<实际备份目录>'
```
