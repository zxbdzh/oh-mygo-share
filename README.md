# Oh MyGo Share

Oh MyGo Music 的独立自托管听歌分享服务。分享者上传音频副本与封面，接收者打开链接即可收听，不需要注册；分享者关闭播放器后，链接仍由自己的服务提供。

## 自托管运行

1. 将 `.env.example` 复制为 `.env`。
2. 将 `PUBLIC_ORIGIN` 设置为反向代理提供的 HTTPS 地址，不包含路径或查询参数。
3. 使用 `openssl rand -hex 32` 等方式生成随机管理令牌，填入 `SHARE_ADMIN_TOKEN`，不要提交或公开此令牌。
4. 按宿主数据目录的所有者设置 `PUID` 和 `PGID`，默认均为 `1000`。
5. 将 `SHARE_DATA_DIRECTORY` 指向该用户可读写的持久化目录。
6. 需要部署时运行 `docker compose up -d --build`。

服务默认只映射到宿主的 `127.0.0.1:3000`，请通过 HTTPS 反向代理对外提供访问，并为代理配置适当的上传大小限制。SQLite 数据库与媒体文件保存在 `SHARE_DATA_DIRECTORY`；请妥善保护和备份此目录。

在桌面播放器的「设置 → 在线分享」中填写服务地址与相应管理令牌。令牌不能发给收听者；每个独立服务应使用自己的随机令牌。

## 分享与收听

支持整首歌曲或歌词对应的连续音频片段。片段在服务端实际裁剪，歌词同步换算为片段时间；接收者不能从片段页切换到整曲。网页沿用分享时的封面与选句，采用 MyGo Music 正在播放页同款布局；分享卡片的模板选择仍保留。

收听时可在「歌词」和「律动」之间切换。律动提供流光、云阶、倾诉、聚光、声波五种效果，可选择舒缓、标准或活跃强度，开关火花，并切换双语、原文或译文。显示偏好保存在当前浏览器中。间奏会展示封面和进度，随分享提供的热评也可在间奏显示。

新分享可保留原有的逐词节奏；较早生成的链接仍能使用律动，缺少逐词时间时按行区间分配显示动效。声波跟随实际播放的音频，浏览器无法分析时显示安静基线。暂停会停住律动，离开律动页或将页面切到后台也会停止持续绘制，播放与分享的有效期规则不变。

律动优先使用收听设备的显卡加速，文字和封面会缓存复用。浏览器不支持或显卡暂不可用时自动使用兼容渲染，仍可正常收听；NAS 无需显卡。

分享地址为 `/s/:token`，持有链接的人可以访问和转发。每次实际打开页面续期 24 小时，聊天预览、封面读取和播放心跳不续期。过期链接不能自行恢复。

分享者可以撤销链接。撤销或过期后不允许开始新的收听；已经开始的会话仍可听完，但连续暂停或断联 15 分钟后结束。已经送达接收者设备的音频无法追回。

## 管理 API

所有管理接口均需 `Authorization: Bearer <SHARE_ADMIN_TOKEN>`。

- `POST /api/shares`：创建分享。携带稳定的 `Idempotency-Key`，使相同请求的重试不会重复创建。
- `POST /api/shares/reuse`：查找相同完整分享内容的有效链接；请求体与创建接口一致，命中返回详情，未命中返回 204，不延长有效期。
- `GET /api/shares`：列出分享；可选 `limit` 为 1–100。
- `GET /api/shares/:id`：读取处理状态，完成后返回听歌链接。
- `PUT /api/shares/:id/cover`：在音频上传前上传 JPEG、PNG 或 WebP 封面。
- `PUT /api/shares/:id/audio`：上传所选音频；校验及片段裁剪成功后才发布链接。
- `DELETE /api/shares/:id`：撤销分享。

公开页面打开时发送 `POST /api/public/:token/open`；播放时创建收听会话，音频请求携带会话标识并支持 HTTP Range。`GET /healthz` 用于运行状态检查。

## 本地开发

需要 Node.js、npm、FFmpeg 和 ffprobe。安装依赖后可使用以下命令：

```sh
npm ci
npm run dev
npm test
npm run check
npm run build
```

本地 API 调用同样需要设置 `SHARE_ADMIN_TOKEN`，`PUBLIC_ORIGIN` 决定返回的链接地址。FFmpeg 或 ffprobe 不在 `PATH` 中时，分别设置 `FFMPEG_PATH` 与 `FFPROBE_PATH`。本地开发可使用 localhost HTTP，正式访问应使用 HTTPS。

## 资源限制

- `SHARE_MAX_UPLOAD_BYTES`：音频输入和处理结果大小上限，默认 512 MiB。
- `SHARE_MAX_STORAGE_BYTES`：媒体目录容量预算，含封面和临时上传，默认 10 GiB。新上传预留输入与输出空间，超限返回 HTTP 507，不删除仍有效的分享。
- `SHARE_MAX_CONCURRENT_JOBS`：同时处理数量，默认 2。繁忙时返回 HTTP 429 与 `Retry-After`。
- `SHARE_MAX_DURATION_MS`：处理结果的实测时长上限，默认 24 小时。

片段模式对选定区间解码重编码，整曲模式在校验实际容器与时长后保留原始音频。能否播放仍取决于接收者浏览器支持的编码格式。请只分享有权传播的内容，并按实际环境验证镜像构建、宿主卷权限和 HTTPS 配置。
