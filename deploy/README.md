# 阿里云服务器隔离部署

站点地址为 `https://huayuan.ink/aiVideo/`。沿用现有站点的 HTTPS 证书，只增加该路径的转发；页面、API、播放器、音色试听和带签名素材链接均支持 `/aiVideo/` 前缀。

## 目录和资源隔离

- 专属目录：`/opt/aivideo-replica`，不使用 `server.json` 中已有项目的 `remoteProjectDirectory`。
- 源码版本：`/opt/aivideo-replica/releases/<源码包摘要>`。
- 私有凭证：`/opt/aivideo-replica/.env.server`，权限 `600`，与源码包和镜像分开。
- 持久数据：`/opt/aivideo-replica/data`，只挂载至本项目容器的 `/app/runs`。
- 独立 Compose 项目名／网络：`aivideo-replica`；只发布 `127.0.0.1:14173`，不占用宿主机现有的 80、443、18080 端口。
- 单容器上限：576 MiB、0.50 CPU、256个进程，软内存预算192 MiB；日志单文件10 MB、最多三份。Node堆128 MiB，FFmpeg编解码／滤镜单线程，Hypit媒体任务串行、浏览器单实例，使用专用Chromium Headless Shell，并限制待编码帧及解码缓存。不修改其他项目的资源上限。

低内存模式还将V8年轻代限制为2 MiB，并在Hypit执行期间只读观察固定版本的本地调度记录，避免频繁启动完整CLI与执行器争用内存。执行结束、出现人工处理或失败信号时，仍由原生CLI确认最终状态并导出成片；不写入原生数据库、不替换编译或合成引擎。

2026-11-15 检查服务器总内存约3.7 GiB，可用约860 MiB；主要由现有Java和MySQL服务占用。构建和运行分阶段执行：构建容器上限384 MiB、启动前至少640 MiB可用；运行容器上限576 MiB、启动前至少832 MiB可用，均为共享宿主机保留256 MiB余量。视频任务开始前再次检查宿主机至少256 MiB及本容器至少320 MiB空余，不足时在收费请求前停止。不会停止、重启或修改其他容器来腾出内存。

已经在576 MiB限制下完成1秒、320×180的离线原生合成检查，并完成公网登录、音色库页面、带签名素材的HEAD／Range、篡改和过期拒绝检查。此检查不包含收费模型生成，也不是长视频／高分辨率负载验收。工作台空闲占用约42 MiB，部署后宿主机可用约821 MiB；既有9个容器的ID、启动时间和重启次数保持不变。

## 准备和上传

在项目根目录执行：

```powershell
node scripts/prepare-deployment.mjs
node scripts/stage-deployment.mjs
```

第一步从本机 `.env` 提取火山配置，独立生成服务器素材签名密钥和工作台密码，保存到被忽略的 `runs/deployment/.env.server`。已有服务器密码和签名密钥会保留，重复打包不会自动轮换。第二步使用 `server.json` 中的 SSH 连接信息，固定并核对服务器主机指纹，只上传到本项目目录，并执行 `docker compose config --quiet` 验证。不会输出 API Key，也不复制已有本地任务／音色库；首次部署的数据目录为空，正式迁移音色库应连同全部试听、确认与账号绑定记录一起迁移。

## 启动和 Nginx 接入

1. 在服务器中进入准备脚本返回的版本目录，执行 `sh deploy/start-isolated.sh`。也可分别执行 `--build-only` 和 `--start-only`；构建阶段完成并释放内存后才启动应用。如果Docker Hub连接不通，可设置 `AIVIDEO_NODE_IMAGE=docker.m.daocloud.io/library/node:24.12.0-bookworm-slim` 使用已验证的公共镜像代理，不修改宿主机Docker配置。镜像通过Debian官方包安装FFmpeg／ffprobe，跳过不需要的npm安装脚本，不依赖GitHub二进制下载。禁止执行全局 `docker stop`、`docker system prune`、修改已有项目的Compose文件或重启数据库。
2. 当前已在原有HTTPS server块内增加 `include /opt/aivideo-replica/nginx.locations.conf;`，只挂载 `/aiVideo/`。激活工具为 `deploy/activate-nginx.py`，服务器副本在 `/opt/aivideo-replica/activate-nginx.py`；它先验证私有端口，再备份已有站点配置、执行 `nginx -t` 并平滑加载，核对公网应用和原站点响应，失败时恢复备份。既有 `location /`、证书和其他项目配置保留。
3. 执行 `nginx -t`，通过后使用 `systemctl reload nginx` 平滑加载。若检查失败，应恢复本次新增的 include，不重启已有应用。
4. 用 `.env.server` 中的 `APP_AUTH_USER`／`APP_AUTH_PASSWORD` 登录。`/aiVideo/media/` 不需要浏览器登录，但每个请求都必须携带服务端签名和有效期限；不能直接列出、浏览素材目录。反向代理关闭该路径的访问日志，避免记录完整签名链接。
5. 验证原有 `https://huayuan.ink/` 仍正常、本项目登录及静态资源正常、签名下载及 Range 正常。验证不提交视频任务、音色注册、试听或正式启用；用户仍须逐轮确认试听和最终音色槽位付费。

服务器操作指南中的命令只针对 aiVideo。删除、回滚时只操作 `aivideo-replica` 项目，保留 `data` 与 `.env.server`；不要加 `down -v` 或清理其他容器／镜像。

## 临时链接和素材清理

`MATERIAL_STORAGE=local` 使用服务器磁盘，TOS 凭证可全部留空。默认链接有效 6 小时、临时副本保留 24 小时，每 15 分钟自动清理。重新发布同一素材会续期，不重复存储；跨进程文件锁协调 Hypit 子进程、下载和清理。链接修改、过期或签名密钥变化都会被拒绝。

服务器镜像省略可选的 TOS SDK，只有选择旧 TOS 后端时才会加载该 SDK。开发环境正常安装可选依赖后仍可使用旧后端；若以后要在镜像内切回 TOS，需要移除 Dockerfile 中的 `--omit=optional` 后重新构建。

临时副本位于 `data/materials/objects`，记录位于 `data/materials/records`；复制时校验内容摘要，清理前校验目录归属、文件类型和保留期限。默认临时副本总额 2 GiB，并为宿主机磁盘预留 2 GiB。达到配额时停止继续发布，不删除其他项目或未过期素材。

原始任务／缓存／成片在 `data/jobs`，独立音色库在 `data/voices`，都不会被自动清理。若需要释放这两部分空间，应先备份并按任务单独处理。手动清理已过期临时副本：

```sh
docker compose -p aivideo-replica -f deploy/compose.yaml exec app npm run materials:cleanup
```

清理只处理有归属标记的临时存储目录，不执行递归目录删除。`MATERIAL_RETENTION_SECONDS` 必须比 `MATERIAL_URL_TTL_SECONDS` 至少多 300 秒。签名密钥轮换会使现有链接立即失效，运行中的任务需保留原密钥直到完成。
