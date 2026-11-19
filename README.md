# MOM 知识图谱服务

前端是静态 HTML 和 JavaScript，后端使用 Python 3.10+ 标准库提供 HTTP JSON API。首次启动时，后端从随工程提供的图谱数据初始化 48 条接口记录。接口新增和编辑保存在 SQLite，接口编号由服务端分配。

## 本地启动

在工程目录打开两个终端，分别执行：

```powershell
python backend/server.py
```

```powershell
python -m http.server 2321 --bind 127.0.0.1 --directory frontend
```

在浏览器访问 http://127.0.0.1:2321 。从「接口管理」新增或编辑记录，保存后刷新或重启后端即可复核。原离线页面曾保存在浏览器 localStorage 的个人修改需要先从原页面导出，再通过接口录入。迁移包提供的 48 条初始记录会自动加载。

## API

默认地址为 http://127.0.0.1:9284 。所有响应均为 JSON，OPTIONS 预检响应为空。

| 请求 | 用途 |
| --- | --- |
| GET /api/health | 检查服务及接口表可用性 |
| GET /api/graph | 返回全量图谱及当前接口记录 |
| GET /api/taxonomy | 产品分类 |
| GET /api/products/bd | 产品详情 |
| GET /api/modules?code=bd | 查询产品下的模块 |
| GET /api/features?product=bd | 查询产品下的功能点 |
| GET /api/existingLinks | 现有联动 |
| GET /api/suggestedLinks | 建议联动 |
| GET /api/moduleRefs 和 /api/featureRefs | 模块与功能引用 |
| GET /api/qa?product=bd | 查询产品问答 |
| GET /api/interfaces/IF-001 | 接口详情 |
| POST /api/interfaces | 新增接口，返回 201 及服务端生成的编号 |
| PUT /api/interfaces/IF-001 | 更新指定接口，返回 200 及更新后记录 |

集合接口支持字段精确筛选和 q 全文子串搜索。查询参数可组合使用。有编号的资源支持按编号查询。写入接口接受 Content-Type: application/json，字段与接口详情一致，提交时移除 id。接口名称须有内容，from 和 to 填写产品 code。原图谱的推断、建议和说明沿用迁移包，接口登记可补充验证记录，文档内容仍需结合原始手册和项目实证核验。

## 独立部署

- 前端可由任意静态站点托管。将 frontend/config.js 中的 apiBase 改成浏览器可访问的后端地址。同域反向代理 /api 时可将 apiBase 设为空字符串。
- 后端启动参数支持 --host、--port、--db 和可重复的 --origin。跨域部署时为前端站点设置精确来源，例如 --origin https://mom.example.com。
- 部署到其他机器时，后端需同时带上 server.py 和 graph.json，并将 --db 指向可持久化的磁盘目录。默认数据库位于 backend/interfaces.sqlite3。迁移时先停止写入再复制数据库，或使用 SQLite 在线备份。
- 服务面向本地和受控验证环境。团队部署时通过带身份验证和 TLS 的网关限制 API 和前端访问。后端自身未配置身份认证或 TLS。

## 业务全追溯

「业务全追溯」按基础数据、业务数据、功能三类查询。基础数据和业务数据按细分类与对象编号查询，另提供明确标注的模拟原型。功能查询按产品及模块选择功能，展示知识图谱中的功能说明和已登记的直接关联，页面标注功能说明整理、产品联动推导或建议关系。

通过 `python backend/server.py --trace-dir <目录>` 配置真实追溯数据。对象图保存为 `objects/<type>/<category>/<编号的 UTF-8 十六进制编码>.json`，例如设备 001 对应 `objects/master/equipment/303031.json`。分类为 `master/person`、`master/equipment`、`master/material`、`business/batch`、`business/document`。后端每次查询读取对应文件，部署需同时带上 `trace_data.py`。旧版未分类 API 仍支持原先的目录格式。

图谱 JSON 包含 `title`、`nodes` 和 `edges`。节点填写 `id`、`label`、`kind`，关系填写 `from`、`to`（节点 ID）和 `label`（数据用途）。节点和关系可填写 `details`，对象图可填写 `focus` 指定默认选中的节点 ID。

## 许可

本仓库的自有代码及内容按 [个人非商用许可](LICENSE) 提供，仅限个人非商用。第三方引用资料仍适用其原有权利及条款。
