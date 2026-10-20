# EssayFlow 数据 Schema 与迁移说明

本文记录 M1-M5 已实现的数据边界。验收事实以源码、对应 gate 退出码及同源机器报告为准。

## Workspace 边界

业务数据写入 Electron `userData/workspace/`：

- `projects/{projectId}/HEAD.json` 指向当前完整提交，`commits/` 保存原子 ProjectAggregate，`versions/` 保存可恢复检查点。
- `library/library.json` 是全局 LibraryItem、Collection 与 revision 的单一 envelope。
- `assets/` 按内容 hash 管理 PDF、图片和归档资源。
- `settings/exportable-settings.json` 只保存白名单公开设置。
- `credentials/provider-credentials.json` 只接受 safeStorage 密文；不可用时拒绝持久化。

所有写操作携带 `baseRevision`，只有主进程完成原子替换和 durable ack 后 renderer 才能显示已保存。项目索引是可重建缓存，不是项目存在性的真相。

## ProjectAggregate

`src/main/data/schema.js` 校验 ProjectAggregate 根 envelope、manifest、HTML canonical document 和稳定集合。当前专用业务对象包括：

- CitationItem：项目内 CSL-JSON 快照，使用稳定 `citationItemId`，可关联全局 `libraryItemId`；结构化 author/editor 不压平。
- CitationLink：`id` 即正文 `data-citation-instance-id`，`items` 支持多文献簇、顺序、locator/label、prefix/suffix 和 suppressAuthor。
- ProjectPaperState：按项目关联 CitationItem，筛选状态与阅读状态正交；排除状态必须有原因。
- EvidenceCard/EvidenceRevision/EvidenceReviewEvent：证据版本不可变；AI 首事件只能是 proposed，用户审阅以第二个事件追加，不能覆写历史。
- AuditEvent、GroundedAnswer 与 ReviewIssue：AI 请求、结果、接受、拒绝、再生成和恢复保留顺序及项目归属，引用来源必须能回到同项目证据版本。
- ReviewMatrix：行只引用本项目 included CitationItem；每格带稳定 `citationItemId`、来源依据和审阅状态。AI 格必须绑定同项目 `matrix-extraction` result；PDF 格的 EvidenceRevision 首审事件必须与该格绑定同一个 result。

CitationLink、ProjectPaperState、EvidenceRevision 和 ReviewMatrix 行不得悬空或跨项目。正文显示编号不参与业务主键。摘要预填保存正文快照和 SHA-256、保持 draft 且不创建 PDF EvidenceCard；全文预填创建不可变 EvidenceRevision 与 proposed 首事件，证据确认和矩阵格确认是两个独立的用户动作。

## 综述矩阵与导出

`src/main/matrix/matrix-service.js` 以 ProjectAggregate 内的 `reviewMatrices` 为单一真相。默认列覆盖作者、年份、研究问题、方法、样本、变量、结论、局限、与本研究关系和证据摘录。手工格设置 `userEdited=true`，AI 重跑只在用户逐格确认后覆盖。

批处理最多 50 篇，每行持久化 queued/running/completed/failed/canceled；完成行独立提交，取消后保留已完成行并明确标记其余行。CSV ZIP 固定包含 `matrix.csv` 与 `sources.csv`，XLSX 固定包含 Matrix 与 Sources；来源表保存 matrix/cell/citation/evidence/revision/page/quote/basis/reviewStatus，所有可执行公式前缀均被转义，且不生成宏或外部工作簿链接。

## 全局文库

`src/main/data/library-store.js` 保存 CSL 字段、结构化姓名/日期、metadataProvenance、fieldConfidence、标签、星标、私人笔记和 assetRefs。集合成员只存在 `envelope.collections[].itemIds`，LibraryItem 不保存 `collectionIds` 双份真相。

标准交换由 `src/main/citation/exchange.js` 实现：

- CSL-JSON 携带 `_essayflow` 扩展并对应用支持字段无损往返。
- BibTeX 与 RIS 只保证格式可表达字段，固定损失定义在 `field-loss-matrix.json`，导出 UI 和机器结果都显示 loss report。
- DOI 优先去重；无 DOI 使用规范化标题、首作者和年份。人工字段冲突必须显式选择。

## Legacy 迁移

`src/main/data/migrator.js` 在任何业务写入前创建可校验只读备份，然后以固定 namespace 生成稳定 UUID。迁移输出直接使用现代 CitationLink `items` 契约；旧 `paperId + number` 只保存在迁移映射/兼容输入中。

迁移具有以下约束：

1. 同一输入重复执行不会重复项目、文献、引用或资产。
2. 源数据变化、未来 schema、损坏目标或 checksum 不一致时只读失败。
3. 中途失败保留旧数据与备份；下次使用稳定 ID 续迁。
4. 全局文库删除/合并不修改项目 CitationItem 快照或 CitationLink。
5. renderer 全量文库 DTO 往返保留已存在的标准导入 UUID。

验证入口：

```powershell
npm run test:repository
npm run test:migration
npm run test:integrity
npm run test:matrix
npm run test:m5-e2e
npm run verify:data -- --profile "test/fixtures/workspaces/acceptance" --deep
npm run gate:m5
```

任何源码或本文修改都会改变 `sourceTreeSha256`，必须重新运行 gate 后才能引用机器报告。
