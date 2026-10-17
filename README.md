# FilmDock 0.2 Desktop Demo

一个把剧本、资产、分镜、图像与视频生成、素材筛选和粗剪交接放在一起的桌面客户端 Demo。CLI 和 HTTP API 均由用户自定义；没有预绑定付费平台。

## 直接运行 Windows 便携版

完整解压 `FilmDock_Demo_v0.2_Windows_x64.zip`，双击同一目录下的 `FilmDock.exe`。请保留旁边的 resources、locales 和 DLL 文件；不要只把exe单独拷走。便携版自带Electron运行时，不需要安装Node.js或npm。

打包目标是 Windows x64，建议 Windows 11。已在Linux环境实际启动同版Electron应用并完成端到端测试；Windows便携包已构建和检查，但尚未在Windows真机上执行。

打开后进入原创演示项目《雨停之前》，有6个镜头、4个资产和一条20秒的初始粗剪。内置图像由代码绘制，内置视频是这些图像的简单动态展示，均标注为演示素材，并非AI模型生成。

## 先体验这一条流程

1. 在“剧本工作室”查看和编辑原文，使用“生成拆镜草稿”按段落追加镜头。
2. 在“资产库”新建角色、场景或道具，导入参考图，也可用连接生成图像。
3. 在“分镜画板”选中镜头，编辑画面、景别、机位、时长和提示词，引用资产。
4. 点击“生成关键帧”或“生成视频”，选择内置演示或自己的连接。真实调用前需要确认可能产生平台费用。
5. 在“视频素材”预览候选并点击“采用素材”。新生成结果不会自动覆盖旧候选。
6. 在“粗剪台”一键铺排已采用视频，拖动重排、设置入出点、静音、撤销或重做，连续预览。
7. 顶部“导出交接包”生成ZIP。通过左上项目菜单的“打开交接 ZIP”可以在另一目录继续制作。

初始第5和第6镜尚未采用视频；可以先用演示连接生成、在素材库采用，再重建粗剪为完整6镜。新建项目或恢复演示会替换当前工作区，请先导出当前项目。

## 自定义 CLI

进入“连接与模型”，选择CLI卡片，或“添加连接”后按需要配置。填写程序路径、参数数组、模型名、输出类型、JSON输出字段和表示方式。密钥通过单独指定的环境变量注入。CLI以shell=false启动，提示词通过stdin及request.json传递。

示例：本机有Python时，可用附带的 `examples/demo_cli.py` 验证连接。它只复制演示图片，不调用任何AI平台。

| 字段 | 示例 |
| --- | --- |
| 程序 | `C:\Python312\python.exe` 或本机可用的 `python` |
| 参数数组 | `["C:\\FilmDock\\examples\\demo_cli.py", "{{inputFile}}"]` |
| 输出类型 | `image` |
| 输出字段路径 | `output.path` |
| 结果表示 | `path` |

参数里的示例路径要换成你实际解压的位置。自定义程序最后输出例如 `{"output":{"path":"C:/work/result.png"}}`。也支持将输出映射为URL或Base64。CLI可以运行一个持续等待远端结果的包装脚本；本版没有通用的异步CLI查询子命令配置。

## 自定义 HTTP API

添加API连接，填写真实平台的POST提交地址、请求头、请求体模板、输出字段路径、结果表示和模型ID。密钥填写到独立密钥栏，再指定请求头名称与前缀；不要把密钥放在URL、普通请求头JSON或提示词里。

请求体模板中的 `{{prompt}}`、`{{model}}`、`{{duration}}`、`{{ratio}}`、`{{firstFrame}}` 和 `{{references}}` 会被替换。完整字段值为一个占位符时保留原始类型，所以 `"{{duration}}"` 会成为数字，`"{{references}}"` 会成为数组。首帧为Data URI；有些平台要求先上传文件并取得URL，这种平台需要自行写上传包装CLI或中间API，本版不自动适配上传协议。

例如同步图片接口可使用：

```json
{
  "model": "{{model}}",
  "prompt": "{{prompt}}"
}
```

若返回 `{"data":[{"url":"https://.../image.png"}]}`，输出路径填 `data.0.url`，表示选url。若返回Base64字段，改成对应路径和base64。平台直接返回图片或视频二进制也能接收。

异步视频接口勾选“这是异步任务 API”，设置提交响应任务ID字段、查询地址、查询方法GET或POST、状态字段、成功和失败状态值，以及轮询间隔。查询地址支持 `{{taskId}}`；POST查询体也支持该变量。输出字段按查询成功时的响应结构填写。支持“同源媒体下载也需要鉴权”，密钥不会发送到不同来源的结果URL。

“检查配置”只检查地址、模板或CLI程序位置，不生成、不收费，也不代表账号或平台已经接通。真实调用需自行核对平台参数、权限、额度与收费。第三方付费平台尚未实测。

## MP4 粗剪导出

桌面版通过FFmpeg渲染MP4。请在本机准备 `ffmpeg.exe`，建议同时有同一目录的 `ffprobe.exe`，然后在“连接与模型”的“粗剪渲染工具”里填写ffmpeg.exe的完整路径；已经加入PATH则保留 `ffmpeg` 即可。FFmpeg官方下载入口：https://ffmpeg.org/download.html 。

本便携包不附FFmpeg命令行程序。旁边的 `ffmpeg.dll` 是Electron内置媒体库，不能代替 `ffmpeg.exe`。未安装FFmpeg时，剧本、分镜、素材预览和交接ZIP仍可使用，只是不能导出MP4。导出按项目画幅缩放并补边，默认静音，不自动加字幕、配乐或水印。

## 项目保存和交接

项目自动保存到本机Electron用户数据目录下的workspace。Windows通常为 `%APPDATA%\FilmDock\workspace`，具体目录名可能因源码或打包应用名称而不同。源码运行通常为 `%APPDATA%\filmdock-demo\workspace`。离开当前工作区前，建议导出项目ZIP作可移动备份。

交接包包含project.json、剧本原文、资产和镜头记录、全部已归档媒体、时间线、剪辑清单与SHA256校验清单；不包含连接配置或密钥，MP4需单独导出。本Demo使用 `0.2.0-demo` 交换格式，不是PR、达芬奇或剪映原生工程，也不兼容先前0.1需求资料中的JSON Schema草案。

## 从源码运行

需要Node.js 22或更新版本，以及npm。解压源码包后可双击 `Start_Client.cmd`，或在目录中运行：

```bash
npm ci
npm start
```

`npm run preview` 启动本机浏览器预览，默认地址为 http://127.0.0.1:4173 。浏览器预览支持编辑、演示生成、导入素材、时间线播放及项目ZIP交接；真实CLI/API调用、系统密钥保存和FFmpeg导出仅在桌面客户端可用。浏览器使用localStorage与IndexedDB，和桌面工作区不自动同步。

开发者可以运行 `npm test` 做核心测试，运行 `npm run package:win` 重新生成Windows x64便携目录。平台包与依赖会从网络下载。tools中的原始概念图重建脚本额外需要sharp与FFmpeg；正常运行和打包不需要重建内置素材。

更详细的边界与开发交接见 docs/DEVELOPMENT_HANDOFF.md，测试记录见 docs/TEST_REPORT.md。

## 开源许可

项目源码与内置演示素材以 MIT 许可证发布，详见 [LICENSE](LICENSE)。第三方 fflate 的许可证保留于 `app/vendor/fflate.LICENSE`；其他依赖遵循各自许可证。

## Pixmax CLI 简化接入（配置预览）

在桌面客户端的「连接与模型」点击「连接 Pixmax CLI」：

1. 已安装 CLI：选择 pixmax 可执行程序；或点击「导入 CLI ZIP 包」，选择 Pixmax 发布的技能包。
2. 导入 ZIP 时使用包内的自包含 Runtime，仍需要本机 Python 3.10+；如未加入 PATH，请选择 python.exe。不会自动安装程序、修改系统环境或把 CLI 包上传到仓库。
3. 复用 CLI 已有登录。尚未登录时，在本机终端运行 pixmax auth login web 并完成浏览器授权。也可在客户端的独立密钥栏填写密钥。
4. 点击「检查连接」：自动检测环境、线上鉴权、默认画布与模型；未选择默认画布时可填写画布 UUID。图片和视频使用独立连接配置。

**此版完成的是配置接入，不是可用的 Pixmax 生成适配器。** 当前提供的 CLI 的 node create dry-run 缺少 baseRevision，节点含 fileUuid/isGenerateNode 等协议外字段，并且不支持复用客户端 UUID。客户端因此明确阻止生成；不会绕过检查调用原始接口。需要 CLI 修复普通生成节点协议、稳定 UUID、提交与恢复语义后，才能继续实现生成与结果下载。即使后续 CLI 的 dry-run 改善，本版也不会自动开放生成。

检查连接会执行 CLI 自检、线上只读查询和 dry-run，不创建节点、不提交收费任务。CLI 启动器可能按自身规则检查更新。导入的 Runtime 保存在本机应用用户数据目录的 cli-runtimes 中；项目交接包不包含 Runtime、连接配置或密钥。
