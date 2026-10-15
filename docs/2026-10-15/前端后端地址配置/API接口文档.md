# 前端后端地址配置：接口说明

日期：2026-10-15。

前端统一读取 `frontend/src/config.js` 的 `API_BASE_URL`，再拼接 `/status`、`/connection`、`/sessions` 等接口路径。当前配置为 `/api`，调用 `/status` 时的浏览器请求地址为当前网页来源下的 `/api/status`。后端接口、参数与响应结构没有改变。

开发环境由现有 Vite 代理转发至 `http://127.0.0.1:8797`。部署环境由 Nginx 保留 `/api` 前缀转发至宠物后端；Vite 开发代理不会进入静态构建产物。

发布前修改配置文件，执行 `pnpm run build`，部署完整 `frontend/dist/client`。地址变更须重新打包，不能仅修改服务器环境变量。当前同源部署保留 `/api` 即可；如改成完整独立域名，须另行处理后端域名限制与 CORS。配置中不允许保存任何 Key。

页面中的 MemoryOS 地址是宠物后端访问上游的连接信息，与本次前端访问宠物后端的地址不同。部署细节见项目根 `DEPLOY.md` 第 2、5 节。
