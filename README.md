# 古琴斫制工序记录台（gbguqin）

面向斫琴师与琴坊档案员：把面板底板材、槽腹尺寸、灰胎髹漆遍次与上弦记录串成可回溯的工序档案；音色评价只用文字填写，不做音频文件与波形处理。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21810>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| 构建 | Vite 6（`npm run build` 含 `vue-tsc --noEmit` 类型检查） |
| UI | Element Plus 2 |
| 路由 | Vue Router 4（5 条业务路由 + 404） |
| 状态 | Pinia（boardStore / chamberStore / lacquerStore / stringingStore） |
| 存储 | IndexedDB（Dexie，库名 `gbguqin-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21810
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # wood-board / sound-chamber / lacquer-layer / stringing（+ ui.ts）
│       ├── stores/            # boardStore / chamberStore / lacquerStore / stringingStore
│       ├── components/common/ # DimensionChart / LayerStack / ToneTextEditor / FilterBar / StatBadge / ProcessTimeline / EmptyPanel
│       ├── hooks/             # useGuqinFilter / useStageProgress
│       ├── pages/             # WorkshopBoard / BoardList / ChamberEditor / LacquerLedger / StringingLog（+ NotFound）
│       ├── router/index.ts    # 路由表
│       └── utils/             # layer.ts / db.ts / export.ts（+ wood.ts / seed.ts / id.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 琴坯进度 | 选材/掏膛/灰胎/上弦四阶段统计、推进比、缺失项与工序动态 |
| `/boards` | 板材登记与配对 | 面板底板配对、含水率回显、厚度差、槽腹剖面标注 |
| `/chambers` | 槽腹尺寸记录 | 纳音/龙池/凤沼三处厚度、槽腹深度、天地柱与龙池凤沼尺寸，SVG 剖面标注 |
| `/lacquer` | 灰胎髹漆遍次 | 本坊遍次与外协回执两套来源，按琴号+遍次对账核销、未决不计累计、失败可重试 |
| `/stringing` | 上弦与音色评价 | 灰胎未核销达标时拦截登记；散音/按音/泛音三段纯文本评语、九德简述、缺陷标记与版本对照 |

## 外协回执核销说明

外协漆坊只回传灰胎施工回执，地方批号与本坊遍次常对不上，且存在重复送达、中途退出。髹漆链路将其拆成两套独立来源处理：

- **本坊髹漆遍次**：`lacquers` 表，手工追加，`source='local'`；历史遍次缺来源标记时按本坊记录兼容（v3 升级回填）。
- **外协回执**：`lacquerReceipts` 表，只登记回执原值，不自动新增遍次；回执单号去重，缺单号时按 漆坊+地方批号+琴号+遍次 去重，重复送达只累加送达次数。
- **对账**：按琴号 + 遍次配对，厚度 / 配比 / 施工日期任一不一致即保留双方并标记「待复核」；只有回执的遍次为「仅回执」。
- **累计与进度**：待复核遍次与仅回执遍次不参与累计厚度（累计值沿用上一已核销遍），琴坯进度灰胎阶段不判定完成，上弦登记会被拦截。
- **核销**：可「采用外协值」（本坊旧值快照进 `valueHistory`，该遍及后续累计、琴坯进度立即失效重算，旧值可查阅、可重新对账）或「维持本坊值」。
- **失败保护**：登记回执、核销、重开、删回执先写 `lacquerJobs`，单事务落库成功后才删除；失败时保留核销位置，页面顶部可重试或放弃，动作全部幂等，重放不新增遍次。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbguqin-db`），表：`boards`、`chambers`、`lacquers`、`lacquerReceipts`、`lacquerJobs`、`stringings`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为髹漆表增加 `[guqinNo+seq]` 复合索引并回填历史厚度；`db.version(3).upgrade(...)` 增加外协回执与核销任务两表，并把历史本坊遍次回填 `source='local'`。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入一批示例工序档案（`src/utils/seed.ts`，含一致 / 冲突 / 重复 / 仅回执四种对账样例）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
