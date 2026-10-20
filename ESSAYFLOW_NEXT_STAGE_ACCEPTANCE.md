# EssayFlow 下一阶段执行规格与最终验收标准

版本：1.0  
日期：2026-07-16  
适用范围：EssayFlow v1.1-v1.3 下一阶段产品与工程建设  
目标读者：负责直接修改代码、运行测试、打包并交付结果的执行 AI

> 本文可以直接交给执行 AI。它不是建议清单，而是交付合同。
>
> “界面上出现了按钮”“代码已写完”“语法检查通过”均不等于完成。只有对应里程碑的功能验收、数据完整性、重启持久化、自动化测试、打包产物验证和交付证据全部通过，才允许声明该里程碑完成。

---

## 0. 给执行 AI 的总指令

1. 先完整阅读 AGENTS.md、README.md、package.json、main.js、preload.js 和 src 下全部运行时代码。以当前磁盘代码为准，文档与代码冲突时先记录差异，再按真实代码实施。
2. 保留用户和其他 AI 已有改动，不得重置、覆盖或回退与本任务无关的内容。
3. 必须按 M0 → M1 → M2 → M3 → M4 → M5 的顺序实施。每个阶段只需通过当期递增里程碑门禁 gate:m0…gate:m5；gate:release 仅在 M5 完成后的最终发布执行。不得用 skip 或空测试让尚未实现的未来能力提前“通过”。
4. 每个里程碑都必须形成可独立运行、可独立验收的状态。禁止一次性横跨所有大文件后再统一调试。
5. 不要求改用 React、Vue、TypeScript，也不要求立即升级 Quill。优先在现有 Electron + 原生 JavaScript + Quill 1.3.6 架构中抽出数据层、服务层和测试边界。
6. 新增功能不得继续依赖 renderer 全局变量作为唯一业务真相。跨模块状态需要稳定的数据模型和单一持久化入口。
7. 不得用假数据、硬编码成功状态、静默降级、隐藏错误、跳过测试或仅凭手工观察宣称通过。
8. 任何因环境、证书、Windows VM、真实 API 或外部服务而无法验证的项目，必须明确标记为“未验收/阻塞”，不能写成“预计可用”或“理论通过”。
9. 每完成一个里程碑，更新实施状态、测试结果和未解决风险。总体完成必须满足本文全部里程碑、第 17-20 节和所有一票否决检查。
10. 开工先记录当前文件清单、hash、dirty/untracked 状态和另一 AI 的交接说明。若另一 AI 仍在同一工作区写运行时代码，本任务只能做 M0 只读盘点，不得同时修改重叠文件；待其完成后重新计算 sourceTreeSha256 和 baseline，再开始 M1。不得把并发覆盖造成的差异当作迁移结果。

---

## 1. 产品目标

EssayFlow 的下一阶段定位是：

**可追溯的学术证据写作工作台。**

必须打通以下闭环：

~~~text
发现文献
  → 文库筛选与组织
  → PDF 阅读、选文与证据卡
  → 证据卡插入正文
  → CSL 文内引用和参考文献
  → 点击引用返回 PDF 原文
  → AI 仅基于用户选择的证据回答或修改
  → AI 请求、结果和采用动作可审计
  → 项目可版本恢复和完整迁移
~~~

最终产品承诺只能表述为“出处可追溯、便于用户核对”，不得宣传为“保证正确”“AI 已证明论点”“绝对真实”或“不可篡改认证”。

---

## 2. 交付里程碑

| 里程碑 | 名称 | 必须交付的核心结果 |
|---|---|---|
| M0 | 基线与工程门禁 | 固定测试命令、回归基线、架构边界、离线可打包 |
| M1 | 项目数据核心 | 统一项目聚合、幂等迁移、原子保存、版本历史、备份恢复、回收站 |
| M2 | 引用与文库 | CSL 引擎、BibTeX/RIS/CSL-JSON 交换、引用审计、文库组织与批量操作 |
| M3 | 可追溯证据链 | PDF 文本层、证据卡、证据箱、稳定引用实例、引用回跳 |
| M4 | 可信 AI | 项目聊天、证据限定回答、Diff 审阅、AI 审计账本、敏感项目模式 |
| M5 | 文献综合 | 候选筛选状态、综述矩阵、证据绑定单元格、CSV/XLSX 导出 |

总体完成的定义：M0-M5 全部通过。  
只完成部分里程碑时，最终报告必须写“部分交付”，并明确最后一个通过的里程碑。

---

## 3. 本轮明确非目标

以下内容不得在本轮顺手扩张，除非用户另行书面授权：

- 实时多人协作、多人光标、CRDT、账号和权限系统。
- 云端同步、跨设备自动合并、团队共享文库。
- 扫描 PDF OCR、图片/公式/表格区域证据。
- Zotero 实时双向同步；本轮只要求标准格式导入导出。
- 完整 PRISMA 系统综述、统计元分析和自动质量评分。
- 自建论文爬虫、绕过付费墙或非授权数据库抓取。
- 自建查重、AI 检测或“论文原创率”结论。
- 一键生成整篇论文或自动提交论文。
- 移动端、Web 端或一次性重写前端框架。
- 把本地审计日志宣传为法律级不可否认或防篡改系统。
- 默认对项目正文做磁盘加密；若未实现，隐私说明必须如实说明。

---

## 4. 必须保持的现有能力

以下现有路径必须持续回归，任何一项回归均阻断发布：

1. 新建项目 → 编辑 → 自动保存 → 重启后加载。
2. 历史项目列表、项目切换和项目删除。
3. Word 导入。
4. Word 和 PDF 导出。
5. 多来源论文搜索、手动搜索和自动发现。
6. 收藏文献、本地 PDF 保存和 PDF 预览。
7. 从搜索或文库拖拽引用到编辑器。
8. 现有六种样式的参考文献生成，直至 M2 被 CSL 引擎正式替代。
9. 表格、图片、查找替换、段落拖拽、思维导图。
10. AI 聊天、附件、行内编辑、斜杠命令、中止流式回复。
11. 深浅主题、面板尺寸、快捷键和设置。
12. CiteBlot、TableBlot、PriorityKeywordBlot 的应用内保存与重载。.essayflow 必须业务语义无损；DOCX 只验收规定的视觉与引用语义子集；PDF 只验收视觉导出，不要求恢复应用内部 Blot。

---

## 5. 目标数据边界

### 5.1 总体原则

- 主进程 repository 是项目业务数据的唯一持久化入口。
- localStorage 只允许保存主题、面板尺寸、工具栏偏好等 UI 偏好。
- 正文、项目元数据、引用、证据、版本、AI 历史、AI 审计、PDF、图片不得只存在 localStorage。
- 文库可使用文件数据库、SQLite 或 IndexedDB，但必须有 schemaVersion、迁移器、导出器和一致性校验器。
- renderer 不得持有任意文件写权限；文件通过 assetId、file token 或受管资源 ID 访问。
- 项目索引只能是可重建缓存，不能是项目存在性的唯一真相。
- 可迁移数据中不得写入机器绝对路径。资源使用 assetId 和内容 SHA-256 关联。
- 所有 ID 使用稳定 UUID。当前引用编号、Quill index、数组下标和文件路径均不得作为业务主键。

### 5.2 Workspace 与 ProjectAggregate

实现方式可以是原子 JSON 目录、SQLite 加资源目录或等价方案，但逻辑边界必须明确：

~~~text
Workspace
  workspaceManifest
    schemaVersion
    workspaceId
    appVersion
    createdAt
    updatedAt
  projectsById: ProjectAggregate
  libraryItemsById: LibraryItem
  collections
  assetStore
  exportableSettings

ProjectAggregate
  schemaVersion
  manifest
    projectId
    title
    author
    course
    degree
    wordLimit
    referenceStyle
    privacyMode
    createdAt
    updatedAt
    revision
  document
    canonicalFormat: html
    html
    derivedDelta: optional
  citationItems
  citationLinks
  researchQuestions
  evidenceCards
  evidenceRevisions
  evidenceReviewEvents
  aiThreads
  groundedAnswers
  reviewIssues
  auditEvents
  auditContentBlobs
  projectPaperStates
  reviewMatrices
  assetRefs
  versions
~~~

术语和归属：

- libraryItemId 指全局文库记录。
- citationItemId 指项目内不可变的 CSL-JSON 文献快照，可选关联 libraryItemId。
- 新模型不得继续用含义不明的 paperId。旧 paperId 在迁移时映射到上述两种 ID。
- 从全局文库删除或合并记录，不得破坏项目中的 citationItem 快照和 CitationLink。
- 项目复制、保留两者式导入和 ID 冲突处理必须重映射全部内部外键。
- exportableSettings 使用字段白名单，只包含非秘密设置；凭据不属于 Workspace。
- HTML 是本轮正文唯一 canonical format。derivedDelta 只能作为缓存，不能与 HTML 形成双真相。
- 版本快照是 ProjectAggregate 的可恢复投影：包含当时的 EvidenceReviewEvent，因此证据审阅状态可随版本恢复；不递归包含 versions/backups，也不包含 auditEvents 或 auditContentBlobs。审计账本及其未脱敏 blob 不随历史恢复而回退，只追加 restore 事件；恢复前快照保留恢复前的审阅事件集合。
- EvidenceReviewEvent 随版本快照、私有项目包和整库备份导出恢复；AuditEvent 与未脱敏 AuditContentBlob 按 retention 进入私有项目包和整库备份，但默认不进入对外分享包。

提交必须满足：

- manifest、document、citationItems、citationLinks、证据关系、EvidenceReviewEvent 和 revision 的同一业务动作作为一个逻辑提交；AI/审计动作涉及 AuditEvent/AuditContentBlob 时，事件 envelope、blob 或 redaction 删除与 revision/ack 也必须原子提交。
- 每次提交携带 baseRevision 和 newRevision。
- “已保存”只能在主进程 durable ack 后显示。
- 正文、引用和 manifest 不得出现不同 revision 的混合状态。
- 每个独立持久化 envelope 均有 schemaVersion 和运行时校验。

### 5.3 EvidenceCard 与 EvidenceRevision

~~~text
EvidenceCard
  id: UUID
  schemaVersion: number
  projectId: UUID
  currentRevisionId: UUID
  note: string
  tags: string[]
  color: string
  researchQuestionIds: UUID[]
  status: active | source-missing | source-mismatch | anchor-missing | archived
  archivedAt: optional UTC ISO-8601
  createdAt: UTC ISO-8601
  updatedAt: UTC ISO-8601

EvidenceRevision
  id: UUID
  schemaVersion: number
  evidenceId: UUID
  revisionNumber: positive integer
  citationItemId: UUID
  libraryItemId: optional UUID
  sourceSnapshot:
    assetId: UUID
    fileSha256: lowercase SHA-256 hex
    title: string
    doi: optional string
    metadataSource: api | imported | manual
  locator:
    pageIndex: zero-based integer
    pageLabel: string
    quoteRaw: string
    quoteDisplay: string
    rawQuoteSha256: lowercase SHA-256 of UTF-8 quoteRaw bytes
    displayQuoteSha256: lowercase SHA-256 of UTF-8 quoteDisplay bytes
    pageTextSha256: lowercase SHA-256
    prefix: normalized string, max 256 Unicode code points
    suffix: normalized string, max 256 Unicode code points
    occurrenceIndex: zero-based integer
    rects: normalized canonical rectangles
    pageRotation: 0 | 90 | 180 | 270
    cropBox
    extractorName
    extractorVersion
    transformVersion
    normalization:
      whitespace-collapse | linebreak-join | hyphen-join
    extraction: pdf-text
  createdBy: user | ai
  createdAt: UTC ISO-8601

EvidenceReviewEvent
  id: UUID
  schemaVersion: number
  projectId: UUID
  evidenceId: UUID
  evidenceRevisionId: UUID
  sequence: evidenceRevision-scoped positive integer
  previousReviewEventId: optional UUID
  status: proposed | confirmed | rejected
  actor: user | ai
  sourceAuditResultEventId: optional UUID
  reason: optional string
  createdAt: UTC ISO-8601

SourceCitationSnapshot
  citationItemId: UUID
  title: string
  doi: optional string
  assetId: optional UUID
  fileSha256: optional lowercase SHA-256 hex
  pageIndex: zero-based integer
  pageLabel: string
  rawQuoteSha256: lowercase SHA-256 hex
  quoteText: optional string
  capturedAt: UTC ISO-8601
~~~

SourceCitationSnapshot 是删除、归档或资源失效后仍可解释历史来源的最小不可变快照。metadata-only 审计可以省略 quoteText，但不得省略 citationItemId、title、pageIndex、pageLabel、rawQuoteSha256 和 capturedAt；存在受管 PDF 时必须同时保存 assetId 和 fileSha256。

坐标和文本规则：

- rects 相对 PDF crop box 的未应用页面旋转 canonical 坐标保存，x/y/width/height 均为 0..1；pageRotation 和 transformVersion 必须允许还原到当前视图。
- quoteRaw 来自 PDF.js text item 序列在选择范围内的原始拼接；quoteDisplay 只能由枚举中的确定性 normalization 得到，普通编辑不得修改两者。
- pageLabel 必填；PDF 不提供逻辑页标签时，固定回退为 `PDF 第 {pageIndex + 1} 页`，不得留空或使用不稳定的当前视图文本。
- 相同 exact quote 在同页多次出现时使用 prefix、suffix 和 occurrenceIndex 消歧。
- 普通编辑只能修改 EvidenceCard 的 note、tags、color 和 researchQuestionIds。
- 重选原文创建新的 EvidenceRevision，并更新 currentRevisionId；旧 revision 永不被覆盖。
- EvidenceRevision 创建后任何字段均不可原地修改。repository 只暴露三个语义命令：`createEvidenceFromUserSelection`、`createProposedEvidenceFromAI`、`reviewProposedEvidenceByUser`；不得向 renderer、AI gateway 或矩阵服务暴露可自由传 actor/status 的通用 appendReviewEvent。
- createdBy=user 的 revision 必须与首事件原子创建，首事件固定为 sequence=1、previousReviewEventId=null、actor=user、status=confirmed；createdBy=ai 的 revision 首事件固定为 sequence=1、previousReviewEventId=null、actor=ai、status=proposed，sourceAuditResultEventId 必须指向同项目真实 ai-result。createdBy=user 及后续用户审阅事件的 sourceAuditResultEventId 必须为空。
- proposed 只能通过用户在确认 UI 触发 `reviewProposedEvidenceByUser(revisionId, confirmed|rejected, expectedSequence)` 转为 confirmed 或 rejected；actor/status 由主进程命令写死，不接受 renderer 或模型传值。actor=ai + confirmed/rejected、actor=user + proposed 均由 validator 拒绝。
- confirmed 和 rejected 在本轮均为终态，终态后不得再追加审阅事件；重新抽取或重新考虑必须新建 EvidenceRevision。第二个事件必须 sequence=2、actor=user，previousReviewEventId 指向首事件；其他链长均为完整性错误。
- 当前有效状态由合法链的最大 sequence 派生。本文后续所称 confirmed/proposed/rejected EvidenceRevision 均采用此派生状态；没有首事件、事件断链、重复 sequence、非法 actor/status 组合或 AI 路径伪造用户确认均为完整性错误。
- 架构测试必须证明 AI gateway、matrix extraction 和模型响应解析器只能调用 createProposedEvidenceFromAI，不能导入或间接获得 reviewProposedEvidenceByUser capability。
- 有 CitationLink、GroundedAnswer 或审计引用时，普通删除只能归档；永久删除需要二次确认并保留最小 SourceCitationSnapshot。

### 5.4 CitationLink 数据契约

~~~text
CitationLink
  id: UUID
  schemaVersion: number
  projectId: UUID
  insertionMode: quote | paraphrase | citation-only
  items:
    - citationItemEntryId: UUID
      citationItemId: UUID
      evidenceRevisionIds: UUID[]
      sourceCitationSnapshots: SourceCitationSnapshot[]
      locator: optional string
      label: optional page | chapter | section | paragraph | figure | table
      prefix: optional string
      suffix: optional string
      suppressAuthor: boolean
      order: non-negative integer
      status: active | evidence-missing | source-mismatch
  createdAt: UTC ISO-8601
  updatedAt: UTC ISO-8601
~~~

不变量：

- CitationLink.id 就是 citationInstanceId；CiteBlot 写 data-citation-instance-id 等于该 ID，不再创建含义重复的 blotAnchorId。
- 当前显示编号只由样式和顺序计算，不得作为回链主键。
- 同一论文多次引用是多个 CitationLink，但参考文献按 citationItemId 去重。
- 一个引用簇可以包含多篇文献，每个 item 独立表达 locator 和降级状态。
- locator 为空时 label 必须为空；locator 非空时 label 必填。citation-only 可以同时没有 locator、label 和 evidenceRevisionIds，不得伪造页码类型。
- sourceCitationSnapshots 与 evidenceRevisionIds 长度、顺序一一对应；创建绑定时由对应 EvidenceRevision 生成并持久化。active 状态必须能与 revision/hash 交叉校验，证据永久删除、归档或资源降级后仍保留该快照，不得藏入 schema 未声明字段。
- insertionMode=quote 时每个 item 的 evidenceRevisionIds、locator 和 label 均非空，全部 revision 的派生状态必须为 confirmed；proposed/rejected、非法审阅链或缺失 revision 一律阻断直接引语插入，不得靠客户端隐藏按钮代替 repository 校验。
- 复制/粘贴 CiteBlot 导致重复 citationInstanceId 时，粘贴实例必须分配新 ID，并复制合法关系。
- 重编号、段落拖动、正文前插入新引用后，CitationLink 与 evidenceRevisionIds 必须保持不变。

### 5.5 GroundedAnswer 数据契约

~~~text
GroundedAnswer
  id: UUID
  schemaVersion: number
  threadId: UUID
  projectId: UUID
  auditRequestId: UUID
  auditResultId: UUID
  question: string
  status: complete | partial | invalid
  segments:
    - id: UUID
      text: string
      kind: sourced | inference | insufficient
      userReviewStatus: unreviewed | confirmed | rejected
      sourceRefs:
        - evidenceId: UUID
          evidenceRevisionId: UUID
          rawQuoteSha256: string
          sourceCitationSnapshot: SourceCitationSnapshot
  inputEvidenceRefs:
    - evidenceId
      evidenceRevisionId
      rawQuoteSha256
      included
  excludedEvidence:
    - evidenceId
      evidenceRevisionId
      reason
  modelSnapshot:
    providerOrigin
    providerKind: remote-ai | local-ai
    model
  createdAt: UTC ISO-8601
  updatedAt: UTC ISO-8601
~~~

不变量：

- 模型只能引用本次请求分配的短 token，例如 E1、E2。
- auditResultId 必须指向同项目 ai-result，且该 result.requestEventId 必须等于 auditRequestId；auditRequestId 对应 ai-request 的 operation 必须为 grounded-qa。modelSnapshot 的 providerOrigin/providerKind/model 必须与该 request 的 NetworkContext 一致。
- complete、partial、invalid 的持久化 GroundedAnswer 都必须有上述完整 request/result 链；blocked、aborted 或 error 且未产生 ai-result 时只保存相应 AuditEvent 和 UI 错误状态，不创建 GroundedAnswer。
- 应用层必须把 token 白名单映射回本次 included evidenceRevisionId。
- 未知 token、空 token、被排除证据或 hash 不匹配时，不得生成有效来源标签。
- 无有效 sourceRef 的 segment 不得标为 sourced。
- 模型响应中的 userReviewStatus 不是可信输入；解析器必须忽略或拒绝该字段，并由应用把新 segment 强制写为 unreviewed。只有独立的显式用户审阅命令可以改为 confirmed/rejected。
- GroundedAnswer 可以使用派生状态为 proposed 的证据，但来源标签必须显示“AI 候选/未确认”；rejected 或审阅链非法的证据不得进入 included 集合。证据后来 confirmed 不得自动把 segment 的 userReviewStatus 改为 confirmed。
- inference 显示“AI 推断”；insufficient 显示“证据不足”；sourced 显示“已关联来源”，不显示“已证实”。
- 历史回答固定引用当时的 EvidenceRevision 和 SourceCitationSnapshot，不随证据重锚定静默改变。

### 5.6 AuditEvent 不可变事件契约

所有不可变事件只共享以下 envelope：

~~~text
AuditEventEnvelope
schemaVersion: number
eventId: UUID
projectId: UUID
sessionId: UUID
sequence: project-scoped positive integer
eventType
occurredAt: UTC ISO-8601

NetworkContext
  operation:
    grounded-qa | rewrite | summarize | search-keywords |
    literature-metadata | citation-verify | chat |
    matrix-extraction
  provider:
    origin: canonical scheme://host:port
    providerKind: remote-ai | local-ai | scholarly-api
    model: optional string
  privacyMode: normal | sensitive | local-only
  networkDecision: sent | blocked | local

AuditContentBlob
  blobId: UUID
  schemaVersion: number
  projectId: UUID
  ownerEventId: UUID
  kind: prompt | output | diff | document-context
  sha256: lowercase SHA-256 of exact UTF-8 content bytes
  byteCount: non-negative integer
  utf8Content: string
  createdAt: UTC ISO-8601
~~~

provider、operation、privacyMode 和 networkDecision 不是 restore、accepted、rejected 等本地事件的共享必填字段，只能出现在下列明确要求 NetworkContext 的事件中。事件 payload 是严格的 discriminated union：

~~~text
ai-request:
  networkContext with networkDecision=sent|local
  contentRetention: full | metadata-only
  promptContentBlobId: optional UUID; full 时必填，metadata-only 时必须为空
  promptTemplateVersion
  userPromptSha256
  userPromptByteCount
  contextManifest
  outbound:
    payloadSha256
    byteCount
    unicodeCodePointCount
    sentAt

ai-result:
  requestEventId: UUID
  contentRetention: full | metadata-only
  outputContentBlobId: optional UUID; full 时必填，metadata-only 时必须为空
  outputSha256
  byteCount
  partial
  responseStatus

ai-accepted:
  resultEventId: UUID
  contentRetention: full | metadata-only
  diffContentBlobId: optional UUID; full 时必填，metadata-only 时必须为空
  diffSha256
  baseDocumentRevision
  beforeHash
  afterHash

ai-rejected:
  resultEventId: UUID
  reason

ai-regenerated:
  resultEventId: UUID
  replacementRequestEventId: UUID
  reason

ai-aborted | ai-error:
  requestEventId: UUID
  reason

ai-blocked:
  networkContext with networkDecision=blocked
  contentRetention: full | metadata-only
  promptContentBlobId: optional UUID; full 时必填，metadata-only 时必须为空
  userPromptSha256
  userPromptByteCount
  reason
  outbound: null

restore:
  restoredSnapshotId
  resultingRevision

audit-redacted:
  targetEventIds: non-empty UUID[]
  scope: prompt | output | diff | document-context | all
  redactedBlobs:
    - blobId: UUID
      kind: prompt | output | diff | document-context
      sha256: lowercase SHA-256 hex
      byteCount: non-negative integer
  reason: user-request | project-delete | retention-policy
~~~

不变量：

- eventType 至少支持 ai-request、ai-result、ai-accepted、ai-rejected、ai-regenerated、ai-aborted、ai-error、ai-blocked、restore 和 audit-redacted；运行时 validator 按 eventType 拒绝不属于该分支的字段。
- sequence 由主进程按 projectId 原子递增，projectId + sequence 唯一。
- AuditEvent envelope 只追加且永不原地更新；当前采用状态和脱敏状态从事件流派生。restore 只要求共享 envelope、restoredSnapshotId 和 resultingRevision，不得伪造 provider 或网络决策。
- ai-result、ai-aborted 和 ai-error 的 requestEventId 必须指向同项目中更早的 ai-request；ai-accepted 和 ai-rejected 的 resultEventId 必须指向更早的 ai-result；ai-regenerated 必须同时指向被放弃的 ai-result 和实际创建的 replacement ai-request。关系缺失、跨项目、类型错误、时间倒置或孤儿事件均为完整性错误。
- chat、search-keywords 等无接受动作的 operation 不得伪造 decision。
- payloadSha256 是实际 transport 层发送的 UTF-8 request body bytes 的 SHA-256，byteCount 也是同一字节序列长度。
- origin 去除 userinfo、path、query 和 fragment，防止密钥参数进入审计。
- full 模式把 prompt/output/Diff 正文只保存于独立 AuditContentBlob，事件中仅保存 blobId、hash 和长度；metadata-only 不创建正文 blob，只保留 hash、长度、上下文清单和事件关系。sensitive 默认 metadata-only，用户可显式改为 full；normal 默认 full。任何模式都不能降低外发透明度。
- 脱敏只允许先校验 blob hash，再物理删除选定 AuditContentBlob，并原子追加 audit-redacted；不得修改原 AuditEvent。被脱敏的 full 事件允许 blob 缺失的唯一条件，是存在同项目、更晚且 hash/长度完全匹配的 audit-redacted 事件；UI、导出和恢复均显示“内容已删除”，不得把它报告为普通损坏。
- audit-redacted 自身不得包含被删除正文。脱敏事务的强保证范围是 active profile，以及用户在确认界面明确勾选、仍由应用管理的备份集；这些位置按 blobId/ownerEventId 校验并事务性删除或重写 manifest，后续新生成的项目包/整库备份不得再包含目标 blob。无 redaction 事件的 blob 缺失仍是完整性 error。
- 已由用户复制、发送或移出应用管理范围的既有 .essayflow/备份无法撤回或远程擦除，确认框必须列明这一限制和已知受管副本。验收 fixture 为每个目标 blob 写入唯一 canary，只要求所选受管范围中该 blobId/ownerEventId/canary 命中为 0；另一未选合法 blob 恰好含相同普通文本时不得误报为脱敏失败。
- 不记录 API Key、Authorization header 或其他可复用凭据。
- 可以增加前序 hash 做损坏检测，但不得宣称本地文件不可篡改。
- 审计数据按 projectId 隔离，并随私有完整项目包导出和恢复。

### 5.7 ResearchQuestion 与 ProjectPaperState

~~~text
ResearchQuestion
  id
  schemaVersion
  projectId
  title
  description
  createdAt
  updatedAt

ProjectPaperState
  id
  schemaVersion
  projectId
  citationItemId
  screeningStatus: pending | included | excluded
  exclusionReason: optional string
  readingStatus: unread | to-read | reading | read
  projectNotes: string
  createdAt
  updatedAt
~~~

- 筛选状态、阅读状态是正交维度，不能混成一个枚举。
- isCited 从 CitationLink 派生，不另存一份可变真相。
- 全局 LibraryItem 只保存集合、标签、星标和全局笔记；项目筛选状态保存在 ProjectPaperState。

### 5.8 ReviewMatrix 数据契约

~~~text
ReviewMatrix
  id
  schemaVersion
  projectId
  title
  columnIds
  rowCitationItemIds
  createdAt
  updatedAt

MatrixColumn
  id
  matrixId
  key
  label
  type: text | number | date | enum | evidence
  order
  evidencePolicy: required | recommended | none

MatrixCell
  id
  schemaVersion
  matrixId
  citationItemId
  columnId
  value: optional value matching MatrixColumn.type
  state: empty | value | not-found | failed
  basis: optional user | confirmed-pdf-evidence | proposed-pdf-evidence | abstract-only
  origin: user | ai | import
  userEdited: boolean
  reviewStatus: draft | confirmed | rejected
  evidenceRefs:
    - evidenceId: UUID
      evidenceRevisionId: UUID
      rawQuoteSha256: lowercase SHA-256 hex
  abstractSourceSnapshot: optional
    citationItemId: UUID
    title: string
    abstractText: string
    abstractSha256: lowercase SHA-256 of UTF-8 abstractText bytes
    metadataSource: api | imported | manual
    capturedAt: UTC ISO-8601
  groundedAnswerId: optional
  auditResultEventId: optional UUID
  auditTerminalEventId: optional UUID
  failureCode: optional stable code
  failureMessage: optional string
  revision
  updatedAt
~~~

- evidenceRefs 中每一项必须指向同一项目的真实 EvidenceRevision，evidenceId 和 rawQuoteSha256 必须与 revision 完全匹配；跨项目、失配或孤儿引用均为完整性 error。
- basis=confirmed-pdf-evidence 时 evidenceRefs 非空且全部 revision 的有效 EvidenceReviewEvent 状态必须为 confirmed；basis=proposed-pdf-evidence 时全部 revision 的有效状态只能是 proposed 或 confirmed，且至少一个为 proposed，单元格 reviewStatus 只能为 draft，rejected revision 不得充当依据。
- AI 从全文找到页段时只能创建带 proposed 首事件的 EvidenceRevision；用户确认时追加 confirmed EvidenceReviewEvent，不原地修改 revision。
- basis=abstract-only 时 evidenceRefs 必须为空、abstractSourceSnapshot 必填且 hash 匹配、reviewStatus=draft；摘要模式不得创建伪 PDF EvidenceCard。
- state=value 时 value 和 basis 必填；state=empty、not-found 或 failed 时 value、basis、evidenceRefs 和 abstractSourceSnapshot 必须为空且 reviewStatus=draft。failed 时 failureCode 必填，其他 state 不得伪造 failureCode。
- evidencePolicy=required 的单元格在至少绑定一个 hash 匹配且有效状态为 confirmed 的 revision 前，不得把 reviewStatus 标为 confirmed。reviewStatus=confirmed 还要求 state=value。
- origin=ai 的新单元格 reviewStatus 必须由应用强制为 draft，模型输出的 confirmed 值必须忽略或拒绝；其 EvidenceRevision 后来被用户确认为 confirmed 时，单元格仍保持 draft，只有用户另行确认该单元格内容后才能变为 confirmed。
- origin=ai 不允许 state=empty；state=value|not-found 时 auditResultEventId 必填、auditTerminalEventId 必须为空，result 必须属于同项目且其 request operation=matrix-extraction。origin=ai 且 state=failed 时 auditTerminalEventId 必填并指向同项目对应的 ai-error、ai-aborted 或 operation=matrix-extraction 的 ai-blocked，auditResultEventId 必须为空。
- origin=user|import 时两个 audit 关联字段都必须为空，不得伪造 AI 来源。AI 矩阵结果本次新建的 proposed EvidenceRevision，其 sourceAuditResultEventId 必须等于 cell.auditResultEventId；复用既有 revision 时，该 revision 必须列在对应 request contextManifest 且 evidenceRef/hash 匹配。
- 缺少关联、跨项目事件、错误 operation、request/result 不配对或业务对象与审计结果不在同一原子提交，repository 必须拒绝且零写入。
- not-found 是单元格状态，不是看似正常的字符串值；不得靠批量写入 not-found/empty 绕过正向 fixture。
- 人工编辑后的 userEdited=true，任何覆盖都需要逐项确认。

### 5.9 ReviewIssue 与 ChatAttachmentRef

~~~text
ReviewIssue
  id
  schemaVersion
  projectId
  operationMode: language | structure | logic | terminology | citation-gap
  documentAnchorId
  baseDocumentRevision
  beforeHash
  category
  originalText
  suggestedText
  reason
  status: proposed | accepted | rejected | stale
  auditResultId

ChatAttachmentRef
  id
  schemaVersion
  projectId
  assetId
  extractedSnapshotHash
  retentionMode: reference-only | retain-excerpt | retain-full-managed-asset
  confirmedAt
~~~

- ReviewIssue 应用时 baseDocumentRevision、documentAnchorId 或 beforeHash 任一不匹配，必须标为 stale 并阻断应用；MVP 不自动 rebase。
- reference-only 不在项目包复制附件正文；retain-excerpt 只保存用户确认的摘录；retain-full-managed-asset 才随私有完整包携带受管附件。

---

## 6. 全局完成定义

每个功能项必须同时满足以下要求：

- [ ] 旧项目、旧引用和旧文库无需用户手工操作即可迁移或只读恢复。
- [ ] 新数据结构有 schemaVersion、运行时校验和升级迁移。
- [ ] 迁移前自动生成可恢复备份。
- [ ] 迁移连续执行三次不产生重复 ID、重复引用、重复资源或额外变化。
- [ ] 数据写入失败不会破坏上一个完整 revision。
- [ ] Electron 重启后数据、UI 状态和关系仍正确。
- [ ] 错误状态有明确中文说明和可执行的恢复入口。
- [ ] 不静默截断、静默覆盖、静默降级或把失败显示成成功。
- [ ] 对应纯逻辑有单元测试，持久化有 repository/迁移测试，用户路径有 Electron E2E。
- [ ] 所有自动测试使用隔离的临时 userData/profile，不读取、迁移、覆盖或删除用户真实 profile。
- [ ] 打包后的 win-unpacked 产物通过验证，而不只是在开发目录通过。
- [ ] 核心本地能力在断网环境可运行。
- [ ] 所有新增按钮、菜单、表单、空状态、加载状态、错误状态、取消状态均可用。
- [ ] 键盘焦点、可访问名称、文本溢出、深色模式和 125%/150% Windows 缩放可用。
- [ ] README、AGENTS.md、数据 schema 文档和迁移说明同步更新。
- [ ] 无未说明 TODO、占位按钮、假进度或 console 中未处理异常。

---

## 7. M0：基线与工程门禁

### M0-AC-01 固定命令契约

仓库必须支持 npm ci。除 npm ci 外，最终状态必须在 package.json 中提供并实际实现以下命令：

~~~powershell
npm ci
npm run check:architecture
npm run test:unit
npm run test:repository
npm run test:migration
npm run test:ipc
npm run test:e2e
npm run test:crash
npm run test:integrity
npm run test:security
npm run test:upgrade
npm run test:a11y
npm run test:artifact -- --target win-unpacked
npm run test:artifact -- --target portable
npm run test:artifact -- --target nsis
npm run build -- --dir
npm run build
npm run verify:package -- --app "dist/win-unpacked/EssayFlow.exe"
npm run test:offline -- --app "dist/win-unpacked/EssayFlow.exe"
npm run test:perf -- --app "dist/win-unpacked/EssayFlow.exe"
npm run verify:data -- --profile "test/fixtures/workspaces/acceptance"
npm run verify:dependencies
npm run verify:evidence
npm run gate:m0
npm run gate:m1
npm run gate:m2
npm run gate:m3
npm run gate:m4
npm run gate:m5
npm run gate:pr
npm run gate:release
~~~

里程碑门禁递增：

- gate:m0：当前能力 baseline、测试框架、架构 ratchet、开发版和 win-unpacked smoke。
- gate:m1：在 M0 上增加 repository、migration、upgrade、crash、integrity 和 M1 E2E。
- gate:m2：在 M1 上增加 CSL/文献交换/文库单元测试和 M2 E2E。
- gate:m3：在 M2 上增加 PDF text layer、EvidenceRevision、CitationLink、备份回链和 M3 E2E。
- gate:m4：在 M3 上增加统一 AI gateway、IPC/security、隐私、审计和 M4 E2E。
- gate:m5：在 M4 上增加矩阵、批处理、导出、a11y、性能和 M5 E2E。
- gate:pr 聚合“当前已完成最高里程碑”的快速门禁和一次 Electron smoke，目标 10 分钟内。
- gate:release 只在 M5 后执行；从干净 npm ci 开始，执行 M0-M5 全部门禁、10 次 smoke、三个 Windows artifact、离线、性能、依赖和完整性验证。
- 外部学术 API 和 AI 测试使用本地 fixture/mock，门禁不得访问真实网络或要求真实 API Key。
- M0 不要求尚未实现的 M1-M5 测试提前通过；对应里程碑开工时必须补齐其真实测试。禁止用 skip、空断言或固定成功输出冒充未来测试。
- 最终状态任一目标命令不存在、返回非零或只输出占位文本，总体不通过。

### M0-AC-02 测试基线

必须创建以下最小 fixture：

1. 空首次启动 profile。
2. 当前 legacy HTML + 项目 meta + citations。
3. localStorage + IndexedDB 文库。
4. 中英文、表格、图片、CiteBlot、PriorityKeyword、TableBlot 项目。
5. 损坏 index 但项目文件完好。
6. 截断 JSON。
7. 重复项目 ID 和重复 DOI。
8. 未知未来 schemaVersion。
9. text layer 中文 PDF、英文 PDF、旋转页 PDF。
10. 扫描件 PDF、损坏 PDF、被替换且 SHA-256 不同的 PDF。
11. BibTeX、RIS、CSL-JSON，覆盖中文姓名、机构作者、书籍章节、会议、学位论文和网页。
12. 5000/10000 条合成文献记录。

fixture 不得复制用户真实私密数据。

所有测试和打包 smoke 必须显式指定隔离的临时 userData/profile。测试开始前记录路径，结束后验证用户真实 profile 的文件数量、mtime 和内容 hash 均未变化。任何测试触碰真实用户数据，M0 直接不通过。

### M0-AC-03 架构边界

M0 的 check:architecture 使用 baseline/ratchet 模式：记录当前所有架构违规和 sourceTreeSha256，禁止新增违规，不要求 M1-M4 的目标态在 M0 提前完成。

递增目标：

- M1 结束：repository/migration 之外无业务数据 fs 写入；允许名单之外无业务数据 localStorage.setItem；所有文件/项目 IPC 经统一注册器。
- M2 结束：citation/library 业务数据全部通过 repository 和 schema。
- M3 结束：证据、PDF 资产和 CitationLink 全部通过 repository/asset capability。
- M4 结束：100% IPC 经统一注册器、sender 校验、参数 schema 和稳定错误码；renderer 不持有 API Key 或任意绝对文件路径写能力。
- M5/最终：baseline 违规清零，全部目标态规则阻断发布。
- 所有运行时脚本、样式、worker、字体和 cMap 可从安装包本地加载。
- 不新增远程可执行脚本或 CDN 作为核心启动依赖。

### M0-AC-04 基线回归

至少提供一条 Electron E2E 覆盖：

~~~text
新建项目
→ 输入中英文和标题
→ 插入表格、图片、优先关键词
→ 收藏文献并拖拽引用
→ 自动保存
→ 关闭应用
→ 重新启动
→ 加载同一项目
→ 验证正文、格式、引用和参考文献
→ 导出 Word 和 PDF
~~~

---

## 8. M1：统一数据、版本历史、备份恢复

### M1-AC-01 幂等迁移

Given 当前旧版 profile，When 第一次启动新版，Then：

- 迁移前生成只读备份、manifest 和 checksum。
- 正文、项目元数据、引用、文库、本地 PDF/图片关系完整进入新模型。
- 旧数据在首次成功迁移后不得自动删除。
- 第二次和第三次启动报告 migrated=false。
- 排除日志和时间戳后，第二次和第三次 workspace 语义 hash 不变。

失败场景：

- 任一步失败时不得覆盖或删除旧数据。
- 未知未来 schema 只能阻止写入并提示导出诊断，禁止猜测降级。
- 迁移失败后不得打开空白项目假装成功。

验收产物：artifacts/migration-matrix.json。

### M1-AC-02 原子保存

Given 已保存 revision N，When 保存 revision N+1，Then：

- UI 只在 durable ack 后显示“已保存”。
- manifest、document、citationItems、citationLinks 和当前已实现的项目聚合实体同属 revision N+1。
- 保存并发由主进程按项目串行化。
- 100 次快速连续编辑后，磁盘 revision 等于最后一次 ack。
- ENOSPC、EACCES、文件锁定在 commit point 前失败时，完整 revision N 的 hash 不变。
- 进程在 ACK 前被强杀时，重启后允许得到完整 N 或完整 N+1；收到 ACK 后被强杀时必须得到完整 N+1。
- 任何情况下重启后只能得到完整 N 或完整 N+1，混合状态为 0。

实现文档必须定义 journal 状态机、commit point 和 durable ack：至少包括 temp 文件写完、文件 flush/close、原子替换完成、journal 完成；平台无法保证突然断电语义时必须如实限定为“进程崩溃恢复”，不得夸大。index 是可重建缓存，不属于业务 commit 的唯一真相。

故障注入至少覆盖 temp write、journal、document、citations、manifest 和 atomic replace，每点至少 10 次。

验收产物：artifacts/crash-matrix.json，要求 mixed=0、corrupt=0。

### M1-AC-03 版本历史

Given 项目内容已保存，When 发生以下动作，Then 自动创建有来源标签的快照：

- 用户手动创建检查点。
- Word 导入。
- 接受 AI 修改。
- 恢复历史版本之前。
- 执行影响大量正文或引用的批量操作。

要求：

- 内容 hash 未变化时不生成重复快照。
- 历史列表显示时间、来源动作、标题/字数摘要。
- 恢复前显示正文/标题/字数/引用变化摘要；无法生成细粒度 Diff 时也必须有内容 hash 和元数据预览。
- 恢复历史前先创建“恢复前”快照。
- 快照覆盖当时全部可恢复 ProjectAggregate 状态，包括 manifest、document、citationItems、citationLinks、EvidenceCard/Revision、EvidenceReviewEvent、ProjectPaperState 和 ReviewMatrix；不递归包含 versions/backups，AuditEvent/AuditContentBlob 不进入快照且不随 restore 回退。
- 恢复后正文、元数据、引用、证据关系、矩阵、字数、导图、引用编号和保存状态一致刷新。
- 恢复动作产生新的 revision，不覆盖原历史。
- 连续生成 50 个版本，随机恢复 10 个，语义摘要 100% 一致。
- 默认保留策略可测试，例如最近 20 个自动版本 + 最近 30 天每天 1 个；手动检查点不得被自动 GC。
- 仍被当前或保留版本引用的资产删除数必须为 0。

### M1-AC-04 项目包与整库备份

必须支持：

- 单项目导出为 .essayflow。
- 全部项目、文库、设置和受管资源导出为完整备份。
- 导入到空 profile。
- ID 冲突时选择保留两者、覆盖或跳过。
- 导入前显示包版本、项目/文献/资源数量、展开大小、缺失可选资源、冲突和预计磁盘空间；支持取消且取消后零业务写入。

包内必须包含：

- schemaVersion 和产品版本。
- manifest、正文、引用项、CitationLink。
- 证据卡、EvidenceRevision、EvidenceReviewEvent、AI 历史、AuditEvent、未脱敏 AuditContentBlob 和综述矩阵；尚未存在时使用经 schema 校验的空结构。
- 资产 manifest、文件大小和 SHA-256。
- 项目版本历史。
- 可选本地 PDF/图片；未携带时必须列出缺失资源。
- 普通设置可以进入整库备份，但 API Key、Authorization、safeStorage 密文和其他可复用凭据必须排除；恢复后要求用户重新配置凭据。

可导出设置只允许以下白名单类别：主题、布局、快捷键、默认引用样式、启用的搜索源 ID、providerId、provider origin、model 和非秘密功能开关。恢复后的 credentialStatus 必须为 needs-reentry。

安全要求：

- 校验路径穿越、绝对路径、符号链接/junction、压缩炸弹、文件数量和总大小。
- 任一关键文件失败时整次导入回滚。
- 导入成功后 verify:data errors=0。
- 导出后在空 profile 导入，正文、引用、资产 hash 和文库关联 100% 一致。
- 备份开始前取得一致性 revision 并暂停/排队相关业务写入，不能边修改 localStorage/IndexedDB/文件边复制。
- 保留两者式导入必须重映射 projectId、citationItemId、CitationLink、EvidenceCard/Revision/ReviewEvent、AI、AuditEvent/AuditContentBlob 和矩阵全部内部外键。

canonical hash 规则固定为：UTF-8、LF、Unicode NFC、对象键按字典序、无序集合按稳定 ID 排序、明确区分 null 与缺失字段；机器路径、运行日志和生成时间不进入语义 hash。所有 checksum 使用 SHA-256。

压缩包默认安全上限必须常量化并测试：文件数 <= 20000、单文件 <= 500MB、展开总量 <= 5GB、压缩比 <= 200、相对路径长度 <= 240、目录深度 <= 20；产品需要调整时必须同步测试和文档。全程在 staging 验证，通过后一次逻辑 commit。

### M1-AC-05 回收站

Given 项目被删除，When 回收站未清空，Then：

- 项目、元数据、引用、证据、审计、历史和资源关系可恢复。
- 删除前显示影响摘要。
- 永久删除必须再次确认。
- 仍被其他项目或保留版本引用的共享资源不得删除。

### M1 阻断条件

任一出现即 M1 不通过：

- 迁移前无备份。
- 迁移第二次仍改变业务数据。
- “已保存”早于 durable ack。
- 崩溃后出现 mixed commit。
- 恢复后正文与引用不一致。
- 完整备份不包含证据/引用/审计结构却显示成功。
- 导入部分成功但 UI 显示全部成功。
- 业务数据仍在多个存储中无明确单一真相地双写。

---

## 9. M2：CSL 引用与文库组织

### M2-AC-01 CSL-JSON 内部模型

每条文献至少支持：

- 稳定 item ID。
- type、title、title-short。
- 结构化 author/editor 数组，支持 literal 机构作者。
- issued、accessed。
- container-title、publisher、publisher-place。
- volume、issue、page。
- DOI、URL、ISBN、ISSN。
- abstract、language。
- metadataProvenance、verifiedAt、fieldConfidence。

不得把作者永久压平成不可逆逗号字符串。

### M2-AC-02 标准格式导入

Given 合法 BibTeX、RIS 或 CSL-JSON，When 导入，Then：

- 类型、标题、作者顺序、年份、期刊/出版社、卷期页、DOI、URL 正确映射。
- 标准化 DOI 优先去重；无 DOI 时使用标题、作者和年份组合判断。
- 同一文献字段冲突时展示冲突，用户选择后合并。
- 不静默覆盖更完整的本地人工字段。
- Unicode、中英文姓名、机构作者和特殊字符不损坏。

### M2-AC-03 CSL 引擎

要求：

- 使用成熟 CSL/citeproc 引擎，不继续扩展手写 formatAPA/formatMLA 等生产逻辑。
- 内置 APA 7th、MLA 9th、Chicago 17th、IEEE、Harvard、GB/T 7714。
- 新增 citation-style-lock.json，固定每个样式的官方 style ID、style 版本、文件 SHA-256、locale 版本和数字/作者年份变体；“Chicago”“Harvard”“GB/T”不得只写模糊名称。
- 文内引用和文末参考文献由同一 citation cluster 数据生成。
- 支持数字式和作者-年份式引用。
- 支持多文献引用簇、页码 locator、prefix、suffix、suppress-author。
- 切换样式或重排正文后 locator 和引用关系不丢失。
- IEEE 不重复编号；作者-年份样式不得仍显示固定 [n]。
- 每种内置样式有 golden fixture，与固定期望输出一致。
- golden 期望值必须在接入生产渲染函数前固定，或来自 citeproc/CSL 官方测试数据及人工核对样例；禁止调用待测生产函数生成自己的 expected 输出。

### M2-AC-04 引用审计

导出 Word/PDF 前运行审计，至少检测：

- 正文引用无文献项。
- 文献项未在正文引用。
- DOI/标题重复。
- 关键 CSL 字段缺失。
- 文献身份仅为用户导入且未验证。
- 如未实现撤稿/更正检查，明确显示“未检查撤稿状态”。

M2 不验收尚未存在的 PDF 证据状态；引用对应证据缺失和直接引语页码检查在 M3 增加。阻断问题和警告问题必须区分，用户强制导出时在导出报告中记录；M4 完成后再统一进入 AuditEvent。

### M2-AC-05 导出与往返

Given 文库导出为 BibTeX、RIS、CSL-JSON，When 在空文库重新导入，Then：

- CSL-JSON 是 lossless 往返格式：全部受支持字段、作者顺序、稳定 ID、Unicode 和 DOI 无损。
- BibTeX/RIS 按预先固定的 field-loss-matrix 验收：其格式能表达的字段必须无损；不能表达的字段必须在导出前和 loss report 中列出，禁止伪造 100% 无损。
- 外部格式不要求保留应用 UUID；重新导入时用 DOI 或规范化语义键识别同一记录。
- canonical 核心字段语义摘要按第 8 节的 canonical hash 规则计算。
- Zotero 可通过这些标准格式交换；本轮不要求实时连接。

### M2-AC-06 文库组织

全局 LibraryItem 支持：

- 多集合归属。
- 标签。
- 星标。
- 全局私人笔记。

项目级状态使用第 5.7 节 ProjectPaperState：

- screeningStatus：pending、included、excluded。
- readingStatus：unread、to-read、reading、read。
- excluded 时必须填写 exclusionReason。
- isCited 从 CitationLink 派生，不能手工切换或重复存储。

必须支持：

- 标题、作者、DOI、标签、笔记搜索。
- 年份、来源、类型、PDF 可用性、项目筛选状态和阅读状态组合筛选。
- 排序、批量移动集合、批量标签、批量状态、批量导出和批量删除。
- 操作摘要和撤销。
- 重复合并时保留最完整元数据、PDF、笔记和全部项目 citationItem 映射；M3 加入后再扩展为保留证据关系。
- 移除仍有正文引用的文献时显示引用数和本地 PDF 后果，提供“仅从列表隐藏/保留受管 PDF”；M3 加入后必须同时显示证据数。

### M2-AC-07 引用编辑入口

Given 正文已有 CiteBlot，When 用户点击或通过键盘打开引用编辑器，Then：

- 可添加/移除文献项。
- 可调整多文献簇顺序。
- 可编辑 locator、label、prefix、suffix 和 suppress-author。
- 保存后文内引用与书目立即一致更新。
- 取消不改变正文。
- 支持一次撤销。
- 重启后全部字段保持。
- 引用编辑器有可访问名称、焦点顺序和 Escape 关闭行为。

### M2 性能验收

在 5000 条文献 fixture 上：

- 首屏可交互 <= 2 秒。
- 本地搜索和组合筛选 p95 <= 300ms。
- 滚动无持续冻结，使用分页或虚拟列表。
- DOM 中同时存在的 paper card <= 200。

### M2 阻断条件

- 作者-年份样式仍强制 [n]。
- 切换样式丢页码。
- 导入导出破坏作者顺序或 Unicode。
- 合并文献改变正文 CitationLink 指向。
- 删除文献无提示删除仍被证据引用的 PDF。
- 只替换 UI 文案，生产参考文献仍由旧手写函数生成。

---

## 10. M3：PDF 可追溯证据链

### M3 MVP 限制

- 只支持有 text layer 的 PDF。
- 一张证据卡只能来自同一页。
- 单次选文 1-2000 字符。
- 跨页选择提示拆分，不得静默截断。
- 临时预览 PDF 必须先保存为应用受管资源，才能创建证据卡。
- 扫描件明确显示“当前版本不支持 OCR”，不得用乱码或空文本建卡。
- 不修改 PDF 原文件，不承诺兼容全部第三方 PDF 批注格式。

### M3-AC-01 PDF 文本层与搜索

Given text PDF，When 打开，Then：

- 文本可选择。
- 支持全文搜索和上一处/下一处。
- 搜索结果显示页码并可准确跳转。
- 旋转页、缩放和面板宽度变化后文本层仍与 Canvas 对齐。
- PDF 初次渲染保持懒加载，不因增加文本层一次渲染全部页面。

### M3-AC-02 创建证据卡

Given 已收藏且有 text layer 的 PDF，When 用户单页选文并点击“保存为证据”，Then：

- 创建 EvidenceCard 和 confirmed EvidenceRevision，保存 quoteRaw、quoteDisplay、normalization、zero-based pageIndex、pageLabel、prefix、suffix、occurrenceIndex、canonical rects、pageRotation、cropBox、citationItemId、assetId、extractor 版本和 PDF SHA-256。
- PDF 显示持久高亮。
- 右栏“证据”视图立即出现卡片。
- 重新启动并打开同一项目/PDF 后，卡片和高亮仍存在。
- 点击卡片滚动到同一页同一段。
- repository 负向测试必须拒绝：AI 路径提交 actor=user/status=confirmed、任意路径提交 actor=ai/status=confirmed|rejected、终态后追加事件、previousReviewEventId 或 sequence 断链。拒绝后 EvidenceRevision/Event 数量和项目 revision 均不变。

### M3-AC-03 缩放不漂移

Given 已有证据卡，When PDF 从 80% 切换到 150%、窗口缩放到 125%/150%、右栏宽度改变或应用重启，Then 高亮仍覆盖相同原文。固定 E2E 还必须在 90°/180° 旋转页建卡、重启和回跳。

仅保存创建时像素坐标视为失败。

### M3-AC-04 来源缺失或被替换

Given 卡片绑定 SHA-256=A，When PDF 缺失或同一路径变为 SHA-256=B，Then：

- 卡片状态为 source-missing 或 source-mismatch。
- 自动回跳停止。
- UI 展示原来源快照和修复入口。
- 不得把旧坐标套到新文件。
- 用户重新选择 SHA-256 完全相同的受管资源时可恢复 active。
- SHA-256 不同只能作为新来源重新选文，创建新 EvidenceRevision 并保留旧 revision。
- 不得按文件名、标题、页数相似自动信任。

### M3-AC-05 证据箱

右栏新增项目级“证据”视图，至少支持：

- 搜索 quote、note、文献标题和标签。
- 按文献、标签和研究问题分组。
- 编辑 note、tags、color。
- 显示文献标题、页码、原文片段和状态。
- 拖拽到正文。
- 删除/归档前显示被多少 CitationLink 引用；M4 完成后再增加 GroundedAnswer 计数。

编辑 note/tags/color 不得改变 quote、页码或 SHA-256。

### M3-AC-06 插入正文

拖入正文后提供：

1. 原文引用。
2. 转述。
3. 仅插入引用。

要求：

- 原文引用与 quoteDisplay 一致，改换行/断词时保留 normalization 记录。
- M3 的“转述”只接受用户手工输入；转述文本与 source quote 分字段。AI 转述入口在 M4 完成前必须隐藏或禁用。
- 创建稳定 CitationLink；CiteBlot 保存 data-citation-instance-id。
- 引用保存 evidenceRevisionId、locator 和 label。
- 书目按 citationItemId 去重。
- 将 proposed/rejected EvidenceRevision 拖入“原文引用”必须在 repository 层阻断；用户通过独立确认 UI 把 proposed 合法确认为 confirmed 后，同一操作才允许。E2E 同时断言阻断前正文、CitationLink 和 revision 零变化。

### M3-AC-07 回链稳定

Given A=[1]、B=[2]，When 在文首插入新引用或拖动段落导致重编号，Then：

- 编号可变化。
- A/B 的 citationInstanceId 与 evidenceRevisionIds 不变。
- 点击新编号仍跳到正确证据。
- 同论文不同页的引用分别跳到各自页段。
- 一个引用绑定多张证据时，先展示来源列表供选择。

### M3-AC-08 删除保护

Given 证据 E1 被三个正文引用，When 用户删除 E1，Then：

- 显示关联数量与影响。
- 默认只能归档；永久删除需要二次确认。
- CitationLink item 标为 evidence-missing，原 evidenceRevisionId 不改绑，并在对应位置保留 schema 声明的 SourceCitationSnapshot。
- 不静默删除正文，也不自动改绑另一张证据。

### M3-AC-09 证据完整性审计

M3 在 M2 导出审计基础上增加：

- CitationLink 引用的 EvidenceRevision 缺失或归档。
- source-missing、source-mismatch、anchor-missing。
- 直接引语无 locator/pageLabel。
- quoteDisplay 与绑定 EvidenceRevision 的 displayQuoteSha256 不一致。

上述问题必须可逐项定位。阻断/警告分级并允许用户显式强制导出；M4 完成后强制导出动作追加 AuditEvent。

### M3 阻断条件

- 只存高亮坐标，不存原文、页码和文件指纹。
- 扫描件用空文本或乱码建卡。
- 跨页或超长选择被静默截断。
- 编辑笔记时覆盖 source quote。
- 在 M4 前暴露未受审计的 AI 转述入口。
- 引用以当前数字或 Quill index 为唯一关联键。
- PDF 替换后仍静默跳到旧坐标。
- 导出项目包时证据和 CitationLink 丢失。

---

## 11. M4：可信 AI、Diff 与审计

### M4-AC-01 项目聊天

Given 项目有聊天，When 关闭应用并重启，Then：

- 聊天历史按项目恢复。
- 附件使用 ChatAttachmentRef，并按 reference-only、retain-excerpt、retain-full-managed-asset 三种保留模式执行。
- 每次改变保留模式显示将进入项目包的内容，并记录用户确认时间。
- 项目 A/B 聊天不得串库。
- 用户可单独清除聊天历史。
- “清除聊天视图”必须说明 AuditEvent 中是否仍保留 prompt/output；“清除或脱敏审计内容”是独立二次确认动作。

### M4-AC-02 发送范围选择

每次 AI 请求必须明确 operation 和上下文范围：

- 当前选区。
- 指定段落。
- 指定证据卡。
- 指定文献。
- 用户明确选择的附件。

默认不得自动附带全文、整个文库、其他项目聊天或未选择证据。

上下文预算：

- 单次 Grounded QA 默认最多 20 张 EvidenceRevision。
- EvidenceRevision 的 quoteRaw 合计最多 24000 Unicode code points，同时不得超过 provider 的 token 预算。
- 超限时发送前展示 included/excluded 清单并要求用户缩减；禁止静默裁剪。
- “指定文献”必须让用户选择摘要、指定页/证据或全文；不能默认上传全文。
- excludedEvidence 与真实 transport payload 必须一致。

### M4-AC-03 有出处回答

Given 用户只选择 E1、E2，When 提问，Then：

- payload 只包含 E1、E2、问题和必要系统指令。
- 每个 sourced segment 至少有一个来源标签。
- 点击来源标签展示 exact quote、文献、页码并可跳 PDF。
- 100% 有效来源标签映射到本次实际发送且 revision/hash 匹配的 EvidenceCard。
- 未知 E99、模型自造 [3]、DOI 或 URL 不得直接变成有效来源。
- 证据不足时返回 insufficient，不调用网页搜索或用模型常识补写。
- 综合推断标记为 inference。
- 冲突证据分别呈现，不能合并成虚假共识。

应用层硬门禁：

- AI 响应必须通过 GroundedAnswer JSON/schema 校验。
- unknown token、空 sourceRefs 或 hash/revision 不匹配时 fail closed。
- 格式无效时最多自动重试一次；仍无效则 status=invalid，可显示普通未验证文本，但不得显示有效来源标签，也不得作为“有出处回答”一键插入。
- sourced 只是“已关联来源”，userReviewStatus 默认 unreviewed，AI 不得自动设为 confirmed。

正向/负向 fixture：

- 一个固定人工标注问题明确可由 E1/E2 回答，本地确定性 mock 返回带 E1/E2 的 sourced segments；UI 必须正确显示和回跳，禁止实现为永远 insufficient。
- 一个固定问题确实无法由 E1/E2 回答，mock 返回 insufficient；UI 不得伪造来源。
- 一个冲突 fixture 同时提供正反证据，验证双方来源都可见。
- 一个恶意 mock 返回 userReviewStatus=confirmed；解析结果必须为 unreviewed，并记录 schema sanitization/拒绝原因。另用 proposed 证据回答时来源必须显示“AI 候选/未确认”，确认该证据后 segment 仍不自动 confirmed。
- repository 负向测试分别提交缺少 auditResultId、跨项目 result、非 grounded-qa operation 和 request/result 不配对的 GroundedAnswer，全部必须拒绝且零写入；blocked/error 无 result 时不得创建占位 GroundedAnswer。
- 对真实模型的 insufficient/冲突识别只做固定人工标注 corpus 的质量报告，不得把本地 mock 100% 通过宣传为模型学术正确率。

### M4-AC-04 AI 修改 Diff

Given AI 返回修改建议，When 用户尚未接受，Then 正文零修改。

要求：

- 用户先选择范围和 language/structure/logic/terminology/citation-gap 模式；每条结果保存为 ReviewIssue，展示原文、建议、原因、类别和字符级 Diff。
- 支持逐条/批量接受和拒绝。
- 请求携带 baseDocumentRevision、stable documentAnchorId 和 beforeHash；任一不匹配时标记 stale、阻断应用并要求重新生成，MVP 不自动 rebase。
- 接受前创建版本快照。
- 使用 Quill Delta patch 保留非目标格式、引用 Blot、表格和自定义 Blot；不得以肉眼相同的 deleteText/insertText 代替格式保真验收。
- 重叠建议必须检测并要求用户选择顺序或重新生成。
- 接受、拒绝、再生成和恢复均写入独立审计事件。
- 中止或部分流输出标为 partial，不自动插入正文。

### M4-AC-05 审计统一出口

所有现有和新增 AI 出口都必须进入审计：

- 智能搜索关键词。
- AI 文献信息识别。
- 普通聊天。
- 附件聊天。
- 行内编辑。
- 斜杠命令。
- AI 转述。
- 有出处回答。
- 文献真实性查询 citation-verify。
- M5 的矩阵预填 matrix-extraction。

以后任何 AI 或远程学术查询调用都必须通过统一 gateway；新增调用点绕过 gateway 为阻断缺陷。

每次外发至少记录：

- operation。
- provider origin 和 model。
- 提示模板版本。
- 用户提示。
- contextManifest。
- 实际 payload hash、byteCount 和 Unicode code point 数。
- 结果 hash、byteCount 和 partial。
- 接受、拒绝、再生成和恢复通过后续不可变事件表达，不回写 request/result。

### M4-AC-06 审计查看与导出

必须支持：

- 按时间查看项目 AI 操作。
- 查看发送范围、模型、结果和采用状态。
- 导出人类可读报告。
- 导出结构化 JSON。
- 报告包含文献、页码、证据 ID 和 Diff 摘要。
- JSON 可解析且 hash 与本地记录一致。
- 不包含 API Key、Authorization header 或可复用凭据。
- 私有完整备份默认可包含本项目完整审计；对外分享包和审计报告默认脱敏 prompt、output、Diff 和附件摘录，只有用户逐项勾选才包含正文。

### M4-AC-07 外发透明

模式规则：

- normal：首次使用或切换远程 provider 时强确认；此后每次显示非阻塞范围摘要并可展开实际 payload。
- sensitive：每次远程 AI、自动生成的学术搜索 query、远程 PDF 下载都强确认并预览。
- local-only：阻断全部非 loopback 网络，规则见 M4-AC-08。

发送范围摘要至少显示：

- provider 准确 origin。
- 将发送的证据卡数量、文献标题、页码和字符数。
- 是否包含正文范围或附件。
- 用户问题。
- 高级预览中的实际 system/user payload。

UI 清单必须与 AuditEvent contextManifest 和实际 transport 层发往本地 mock 的 payload 一致。真实 provider 只做非阻断兼容手测，不进入可重复发布门禁。

### M4-AC-08 敏感项目模式

项目支持 normal、sensitive、local-only：

- normal：按已授权范围允许远程 AI 和学术搜索。
- sensitive：按 M4-AC-07 逐次确认远程 AI、自动搜索 query 和远程 PDF 下载。
- local-only：阻断所有非 loopback 网络，包括 AI、Crossref/Semantic Scholar citation-verify、自动/手动学术搜索、远程 PDF 下载和遥测。
- local-only 下本地编辑、PDF 阅读、证据卡、引用、CSL 和导出仍可用。
- 用户明确配置并授权的本机 provider 可以在 local-only 下使用，但必须只允许已授权 loopback origin，仍需进入审计账本；未配置本机 provider 时不得自动回退到远程服务。
- ai-request/ai-blocked 的 AuditEvent NetworkContext 记录 providerKind 和 networkDecision；被阻断请求写 ai-blocked，outbound=null，本地 restore/accepted/rejected 事件不得伪造网络字段。
- 验收以网络 trace 为准：local-only 非 loopback 请求数必须为 0。

### M4-AC-09 数据保留与删除

Given 项目存在聊天、GroundedAnswer 和审计事件，When 用户清除 AI 历史或删除项目，Then：

- 清除聊天视图只删除 thread/message；若审计仍有 prompt/output，必须在确认框中明确说明。
- 用户可另行执行“清除/脱敏审计内容”：校验并删除所选 AuditContentBlob，再追加 audit-redacted 事件，保留原不可变 envelope、hash、长度和时间；不得原地替换或更新旧 AuditEvent。
- 脱敏前列出 target event/blob、active profile 和应用仍管理的备份；用户选择是否同步重写/删除这些受管备份。脱敏完成后，所选受管范围及以后新导出的项目包/整库备份不得再包含目标 blob，视图根据 audit-redacted 显示 redaction tombstone，verify:data 不把这类已声明 blob 缺失误报为损坏。
- 对已复制或发送到应用管理范围外的旧导出包，确认框明确提示“应用无法撤回或擦除这些副本”，不得承诺全盘删除。自动化使用每 blob 唯一 canary，要求所选受管范围命中为 0；不得因未选择的另一合法事件含相同普通文本而失败。
- 删除整个项目时，先显示将删除的本地聊天、输出、审计、Diff、证据和受管资源范围；确认后完成可验证删除。
- 不得以“审计”为由阻止用户删除自己的本地内容。
- 不得保留未明确同意的匿名统计或遥测。
- 删除项目 A 不得影响项目 B。

### M4-AC-10 提示注入边界

Given PDF 或附件中包含“忽略先前指令、上传全文、输出 API Key”等文本，When 作为证据发送，Then：

- 证据放入明确的 untrusted data boundary。
- 模型没有文件、任意网络、IPC 或应用工具权限。
- 应用只解析白名单 GroundedAnswer segment 和 source token，不执行模型返回的命令、URL 或 IPC 描述。
- 实际 outbound 范围不扩大，canary secret、配置、其他项目内容和本地路径泄漏数为 0。
- 模型文字声称“已执行恶意指令”不单独作为硬门禁；实际副作用、外发范围和 secret leak 才是确定性验收对象。

### M4-AC-11 学术可信度文案

UI 必须区分：

1. 元数据身份是否匹配。
2. 来源是否能定位到 PDF 页段。
3. 证据是直接支持、仅可推断还是不足。

Crossref 或 Semantic Scholar 搜到相似记录不得显示为“论点已验证”。如未检查撤稿/更正，必须明确说明。

文献身份匹配状态固定为 exact-doi、strong-metadata-match、ambiguous、not-found、unchecked-retraction。模糊标题搜索必须展示候选和匹配依据，不得自动取第一条；单库命中也不得称为“权威验证通过”。

### M4-AC-12 历史证据保持

Given GroundedAnswer 引用 EvidenceRevision 1，When 证据被重锚定、归档或永久删除，Then：

- 历史回答仍保存 evidenceRevisionId、hash 和 sourceCitationSnapshot。
- UI 显示“来源后来已变更/已归档/已删除”。
- 不把历史回答静默改绑到新 revision。

### M4-AC-13 AI 转述

M4 才允许启用“AI 转述”。Given 用户选择 EvidenceRevision，When AI 生成转述，Then：

- source quote 与 paraphrase 分字段。
- 转述先显示 Diff 和来源。
- 用户明确接受后才插入正文。
- 插入前创建快照，并产生 request、result、accepted 事件。
- AI 转述不得显示为直接引语。

### M4 阻断条件

- 用户接受前正文已被修改。
- 旧建议覆盖请求后新编辑。
- Grounded 模式使用未选择证据却不标明。
- 直接信任模型输出的引用编号、DOI、URL 或 evidence ID。
- 证据不足时仍输出确定性结论。
- 发送清单与真实 payload 不一致。
- local-only 模式仍产生非 loopback 请求。
- 账本或日志包含 API Key/Authorization。
- 项目 A 出现项目 B 的证据、聊天或审计。
- 再生成/拒绝/恢复覆盖旧事件，只保留最终结果。

---

## 12. M5：文献筛选与综述矩阵

### M5-AC-01 候选池

使用第 5.7 节 ProjectPaperState：

- screeningStatus：pending、included、excluded；excluded 必须填写 exclusionReason。
- readingStatus：unread、to-read、reading、read。
- isCited 只从 CitationLink 派生。
- 筛选状态按项目保存，同一全局文献可在不同项目中有不同状态。

### M5-AC-02 可配置矩阵

Given 用户选择多篇文献，When 创建矩阵，Then：

- 默认列包含作者年份、研究问题、方法、样本、变量、主要结论、局限、与本文关系、证据摘录。
- 用户可增删列、调整顺序、筛选和排序。
- 每个事实单元格可关联一个或多个 confirmed/proposed EvidenceRevision。
- 点击来源跳到 PDF 页段。
- 手工编辑有 userEdited 标记，不被后续 AI 刷新静默覆盖。

### M5-AC-03 AI 预填

Given 文献有可解析全文，When AI 预填矩阵，Then：

- 每个事实单元格附 citationItemId、evidenceRevisionId、页码、原文片段、basis 和 reviewStatus。
- 全文候选证据由 AI 创建 immutable EvidenceRevision 和 proposed 首事件；用户确认时追加 confirmed EvidenceReviewEvent，确认前不能显示为 confirmed。
- 无法定位时 state=not-found；仅有摘要时 basis=abstract-only、reviewStatus=draft，并保存摘要快照，不创建 PDF EvidenceCard。
- 不得补造出处。
- 一篇失败不影响其他文献。
- 逐篇显示失败原因、重试和取消。
- 重新生成前逐项确认是否覆盖用户手工内容。
- 每篇/每批预填都经过 M4 统一 gateway、privacyMode 和 AuditEvent。
- sensitive 在批次前展示文献、页数、预计发送字符和总预算并确认；local-only 禁止远程预填，但手工矩阵仍完整可用。

正向验收 fixture 必须包含已知方法、样本和结论页码。本地确定性 mock 返回这些字段，E2E 必须填入预期单元格并映射到正确页段；禁止通过“所有单元格均 not-found”形式通过。真实模型另出人工标注质量报告，不把 mock 通过率当模型准确率。

负向 fixture 必须让模型返回 cell reviewStatus=confirmed 并尝试伪造 actor=user 的 confirmed 证据事件；gateway/parser 必须拒绝这些字段，最终 EvidenceRevision 为合法 proposed、cell 为 draft。随后用户只确认证据但不确认单元格，cell 仍为 draft；再次显式确认单元格后才可变为 confirmed。另分别提交缺少 auditResultEventId、跨项目 result、错误 operation、request/result 不配对以及 revision/cell 指向不同 extraction result 的 AI cell，repository 必须全部拒绝且零写入。

### M5-AC-04 批量与导出

要求：

- 50 篇批处理可以取消。
- 每行任务状态为 queued、running、completed、failed、canceled；每个完成行原子提交，禁止半个单元格落盘。
- 取消后已完成内容保留，未完成项状态明确。
- XLSX 至少包含 Matrix 和 Sources 两个 sheet。Sources 包含 matrixId、cellId、citationItemId、title、DOI、pageLabel、evidenceId、evidenceRevisionId、quote、basis 和 reviewStatus。
- CSV 导出为 ZIP，至少包含 matrix.csv 和 sources.csv；不得只写应用本地 deep link 或绝对路径。
- 对以 =、+、-、@ 开头的用户/AI 文本进行 CSV/XLSX 公式注入转义；禁止宏和外部工作簿链接。
- 中文、换行、页码、来源、空值语义和用户列保持完整。
- 导出的每条 AI 预填事实保留证据级别。

### M5 阻断条件

- 无出处内容作为确定事实展示。
- 一个 PDF 失败导致整批数据丢失。
- 刷新元数据或 AI 重跑覆盖人工内容。
- 导出丢 Unicode、页码或来源。
- 来源跳错文献或页码。

---

## 13. IPC、安全、离线与依赖门禁

### 13.1 IPC

- 100% IPC 经可信 sender、参数 schema 和稳定错误码。
- 非应用 frame、data URL 和远程页面发起请求均被拒绝且无副作用。
- 文件路径穿越、绝对路径伪造、junction/symlink 和扩展名伪装均被拒绝。
- file token 必须绑定 webContents、operation、resource、TTL 和单次使用；窗口销毁时立即撤销。
- 超过 1MB 的二进制不得用 Base64 跨 IPC，应使用文件 token、assetId 或流。
- 流式请求必须支持 cancel 和 dispose。
- 100 次成功/错误/取消请求后 listener 数回到基线，活动请求为 0。
- 非法 payload fuzz 1000 组：主进程崩溃 0、越权副作用 0、密钥泄漏 0。

验收产物：artifacts/ipc-fuzz.json。

### 13.2 网络

- renderer 不能构造任意带密钥的请求；主进程按 providerId 注入密钥。
- 默认拒绝 file、ftp、loopback、link-local、私网和重定向到私网。
- 用户明确配置的本地 AI origin 可以单独授权，授权只对该 origin 生效。
- 每次 DNS A/AAAA 解析和每次 redirect 后重新校验目标；跨 origin redirect 必须剥离 Authorization、cookie 和其他凭据 header。
- 本地 origin 授权绑定准确 scheme、host、port，不允许通配域或仅按 hostname 放行。
- 请求体、响应体、空闲超时和重定向次数有上限。
- 取消请求 p95 在 1 秒内关闭底层请求。

### 13.3 密钥

- API Key 不出现在 localStorage、renderer IPC payload、console、日志、诊断包、备份和审计导出。
- safeStorage 不可用时不得静默明文保存；必须提示并拒绝持久化，或让用户明确选择只在本次会话使用。
- provider 记录仅包含 origin 和 model。

### 13.4 离线安装包

从干净环境执行：

~~~powershell
npm ci
npm run build -- --dir
npm run verify:package -- --app "dist/win-unpacked/EssayFlow.exe"
npm run test:offline -- --app "dist/win-unpacked/EssayFlow.exe"
npm run build
npm run test:artifact -- --target portable
npm run test:artifact -- --target nsis
~~~

要求：

- 所有 script、stylesheet、worker、字体、cMap 和运行资产均在包内。
- 远程可执行代码/CDN 数量为 0。
- 网络禁用时连续启动 10 次，失败 0。
- 离线可完成编辑、保存、重启恢复、Word 导入/导出、PDF 导出和本地 PDF 阅读。
- 搜索/AI 在 3 秒内显示离线状态，无永久 loading、白屏或数据改变。
- CSP 核心流程违规 0；script-src 仅 self，不含远程域、unsafe-inline 或 unsafe-eval，object-src 为 none。若 style-src 暂需 inline，必须单独记录原因和收敛计划。
- win-unpacked smoke 连续 10 次失败 0。
- portable 和 NSIS 在干净 Windows VM 各执行启动；NSIS 还需验证从 v1.0 fixture 升级、用户数据迁移和卸载不误删 userData。
- 未通过 Authenticode 签名和时间戳验证的产物只能标为“内部测试包”，不得标为正式发布包。

离线 trace 必须同时覆盖 OS 级网络阻断、Electron session webRequest 和主进程 net broker instrumentation，并分别报告 attempted、blocked、completed 和 origin；只使用 Playwright/Chromium routing 不算完整。

### 13.5 内容输入与窗口安全

test:security 必须覆盖：

- 恶意 .essayflow、旧项目 HTML 和 Word 导入 HTML 中的 script、onerror、javascript URL、iframe、object、远程 CSS/图片 URL 和危险 style。
- sanitizer 使用 allowlist，只保留 Quill 与 CiteBlot、TableBlot、PriorityKeywordBlot 明确需要的标签和属性。
- BrowserWindow 运行时断言 sandbox=true、contextIsolation=true、webSecurity=true、nodeIntegration=false，生产禁用 DevTools。
- window.open、will-navigate、permission request 和外链协议白名单持续生效。
- 自定义 asset protocol 校验路径、MIME、Range、assetId 和调用者。
- BibTeX/RIS/.essayflow/PDF 解析有文件数、大小、页数、耗时和取消上限；超限在后台任务失败，不冻结编辑器。
- Word/PDF 导出不得执行 HTML 或重新加载远程图片。
- CSV/XLSX 无公式注入、宏或外部工作簿链接。

### 13.6 依赖与供应链

verify:dependencies 至少生成：

- npm audit --omit=dev --audit-level=high 的 JSON 报告。
- 运行时 SBOM。
- 第三方 license 清单。
- Electron 当前支持状态。
- package.json/package-lock 一致性和 lockfile SHA-256。

验收产物：

- appPayloadSha256、portable/NSIS 文件 SHA-256 和 win-unpacked canonical tree SHA-256。
- ASAR/runtime asset manifest。
- offline network trace。
- Playwright trace 和关键截图。

---

## 14. 自动测试与覆盖率

建议但不强制更换技术栈：

- 纯逻辑：Node node:test。
- DOM：jsdom。
- 覆盖率：c8。
- Electron E2E：Playwright Electron。

硬性阈值：

- repository、migration、IPC validation、citation engine、paper normalize：lines/functions >= 90%，branches >= 85%。
- migration 已命名 fixture/failure matrix 100% 通过；不机械要求所有不可构造 OS 分支代码覆盖率 100%。
- M0 固化 sourceTreeSha256 和 coverage baseline。若没有可靠 Git base，不得声称 changed-lines coverage；新抽出的模块 lines/functions >= 85%，branches >= 80%。
- 整体覆盖率不得比首次接受的 baseline 下降超过 2 个百分点。
- PR smoke 不允许依赖 retry 才通过。
- release smoke 连续 10 次失败 0。
- 测试不得依赖真实时间、实时网络或用户 API Key。
- 随机/故障测试必须输出 seed 并可重放。

test:a11y 必须验证：

- axe critical/serious=0。
- 仅键盘可完成新建项目、打开文库、编辑引用、创建证据、审阅 Diff 和导出。
- 100%、125%、150% Windows 缩放均有截图和 overflow/overlap detector=0。
- 模态框焦点陷阱、返回焦点、Escape、可访问名称和最长中英文文案 fixture 通过。

---

## 15. 性能验收

固定参考环境：Windows 11、4 核、8GB RAM、SSD、无 DevTools、packaged win-unpacked。  
固定 corpus：

- D1：100k 字符、约 5MB HTML、300 引用、50 表格、200 asset refs。
- L1：10,000 条文献元数据。
- F1：100MB text PDF。

启动、打开和搜索至少运行 30 个独立样本；大文件、导入和 AI stream 至少运行 20 个样本，报告 p50、p95 和 max。冷启动使用新进程和明确冷 cache 策略，暖启动单独测量。

测试报告必须记录具体 CPU 型号、内存、磁盘、电源计划、Windows/Electron/Node 版本。caret-ready、durable ack、input-to-paint 等起止点使用 performance.mark 或等价机器事件定义，不以人工秒表计算。

阈值：

- 冷启动到可输入 p95 <= 5s。
- 暖启动到可输入 p95 <= 3s。
- D1 打开到 caret-ready p95 <= 2.5s。
- 1MB 项目 autosave 到 durable ack p95 <= 750ms，max <= 2s。
- 连续输入 60 秒 input-to-paint p95 <= 50ms，单次主线程阻塞 < 200ms。
- L1 本地搜索 p95 <= 300ms，首屏 <= 2s；该阈值取代 M2 的 5000 条阶段阈值。
- F1 导入时总进程 private bytes 峰值增量 <= 文件大小的 2.5 倍；关闭 PDF 并在测试构建显式 GC 后 retained renderer heap < 64MB。
- 静置干净项目 5 分钟平均 CPU <= 2%，无业务磁盘写入。
- 100 次 AI stream 后 listener 和 active request 必须回到基线；只有测试构建能显式 GC 时才把 retained heap <= 基线 +20MB 作为硬门禁，否则 heap 只报告不判定。
- 同一 runner 相对已接受 baseline 的 p95 或 heap 回归不得 >15%。

验收产物：artifacts/perf-baseline.json，必须包含机器信息、代码版本、artifact hash 和原始样本。只给平均值不算通过。

---

## 16. 必须通过的最终端到端场景

### E2E-01 旧项目迁移与恢复

~~~text
准备含正文、表格、图片、引用和文库的旧 profile
→ 启动新版并自动备份/迁移
→ 连续重启两次
→ 验证无重复数据
→ 编辑并保存
→ 强杀应用
→ 重启
→ 只能出现完整旧 revision 或完整新 revision
→ verify:data errors=0
~~~

### E2E-02 完整项目包

~~~text
创建项目
→ 添加两篇文献和本地 PDF
→ 建证据卡
→ 插入引用
→ 进行一次 AI 操作
→ 创建历史检查点
→ 导出 .essayflow
→ 在空 profile 导入
→ 正文、文献、证据、回链、审计、历史和资产 hash 全部一致
~~~

### E2E-03 CSL 往返

~~~text
导入中文和英文 BibTeX/RIS/CSL-JSON
→ 合并重复 DOI
→ 插入单篇、多篇和带页码引用
→ 点击已有引用，编辑多文献顺序、locator、prefix/suffix
→ 在 APA、IEEE、GB/T 间切换
→ 重启
→ 页码和 CitationLink 不丢失
→ 导出三种格式
→ 空文库重新导入
→ CSL-JSON 核心字段语义摘要一致
→ BibTeX/RIS 可表达字段一致且 loss report 与固定 matrix 一致
~~~

### E2E-04 PDF 证据回链

~~~text
打开一篇中文和一篇英文 text PDF
→ 各建一张证据卡
→ 在普通页和旋转页缩放并改变面板宽度
→ 重启
→ 高亮仍在原文
→ 分别插入正文
→ 在文首新增第三条引用导致重编号
→ 旧引用仍回到正确论文、页码和原文
~~~

### E2E-05 来源失效

~~~text
创建证据和正文引用
→ 删除或替换 PDF
→ 证据与 CitationLink 明确降级
→ 零次错误自动跳转
→ 导出前审计列出问题
→ 修复资源
→ 回链恢复
~~~

### E2E-06 可信 AI

~~~text
选择 E1、E2
→ 用固定可回答 fixture 请求比较研究方法
→ 所有有效来源标签可回到所发证据
→ 用固定不可回答 fixture 验证 insufficient
→ 模拟模型返回虚构 E99
→ E99 不得成为有效来源
→ 模拟无效 JSON/schema，最多重试一次后结果为 invalid
→ 接受一次、拒绝一次、再生成一次、恢复一次
→ 正文 Diff 与版本可恢复
→ 审计顺序完整
~~~

### E2E-07 隐私

~~~text
正常模式选择两张证据
→ 查看范围摘要和高级预览
→ 抓取实际 transport 层发往本地 mock 的 payload
→ payload 只含预览清单内数据
→ 切换 local-only
→ 尝试聊天、行内 AI、关键词、citation-verify、学术搜索、远程 PDF 和矩阵预填
→ 非 loopback 请求数为 0
→ 搜索本地存储、日志和导出
→ API Key/Authorization 泄漏数为 0
~~~

### E2E-08 综述矩阵

~~~text
选择 10 篇文献，其中 2 篇无全文、1 篇损坏
→ 创建矩阵
→ 本地 mock 按固定人工标注字段和页码预填
→ 其余 7 篇的预期方法/样本/结论单元格正常完成并回到正确页段
→ 失败原因逐篇显示
→ 摘要项保持 abstract-only/draft，不伪装为 PDF 证据
→ 修改一个人工单元格
→ 再次生成
→ 人工内容不被静默覆盖
→ 导出 CSV/XLSX
→ XLSX 的 Matrix/Sources 与 CSV ZIP 的 matrix.csv/sources.csv 均正确
→ 中文、页码、证据、basis、reviewStatus 和空值保持
→ local-only 下远程预填被阻断，手工矩阵仍可编辑和导出
~~~

### E2E-09 离线回归

~~~text
构建 win-unpacked
→ 禁用网络
→ 启动 10 次
→ 新建、编辑、保存、重启
→ Word 导入/导出
→ PDF 导出和本地 PDF 阅读
→ 搜索/AI 显示离线错误
→ 无白屏、永久 loading 或数据损坏
→ 在干净 VM 启动 portable
→ 安装 NSIS、从 v1.0 fixture 升级并卸载
→ 用户数据迁移正确且卸载不误删 userData
~~~

---

## 17. 数据完整性终检

必须实现并运行：

~~~powershell
npm run verify:data -- --profile "test/fixtures/workspaces/acceptance" --deep
npm run test:integrity -- --operations 10000 --seed 20260716
~~~

最终要求：

~~~text
schemaErrors=0
checksumMismatch=0
missingRequiredAssets=0
undeclaredDegradedAssets=0
unexpectedDanglingCitations=0
duplicateIds=0
revisionRegression=0
pathEscapes=0
unreachableAssetsAfterGc=0
mixedCommits=0
crossProjectLeaks=0
undeclaredBrokenEvidenceLinks=0
invalidEvidenceReviewTransitions=0
aiConfirmedEvidence=0
unconfirmedQuoteInsertions=0
autoConfirmedAICells=0
unlinkedGroundedAnswers=0
unlinkedAIMatrixCells=0
acceptedUnknownGroundedSourceTokens=0
undeclaredMissingAuditContentBlobs=0
selectedManagedRedactionLeaks=0
secretLeaks=0
~~~

报告同时给出 declaredOptionalMissingAssets、sourceMissing、sourceMismatch、archivedEvidenceLinks、declaredRedactedAuditBlobs 和 rejectedUnknownSourceTokens 的计数。这些合法降级状态可以非零，但必须有一致的状态/tombstone、用户可见提示和可定位修复入口。

资产 ownership 包含 current、history、trash、backup manifest 和 active staging；只有 GC 后完全不可达的资产才计入 unreachableAssetsAfterGc。

随机测试必须覆盖新建、编辑、引用、导入、合并、删除、恢复、备份、重启、证据和 AI 审计，每 100 次操作执行一次完整校验。

---

## 18. 一票否决项

以下任一发生，总体不得验收：

1. 迁移前没有可恢复备份。
2. 迁移不幂等，重复运行产生重复数据。
3. 崩溃后出现 mixed commit。
4. UI 在 durable ack 前显示已保存。
5. 旧项目正文、引用、图片、表格或自定义 Blot 丢失。
6. 业务数据继续多处双写且没有单一真相。
7. 完整项目包遗漏证据、CitationLink、审计或必要资源关系。
8. 引用回链依赖显示编号或 Quill index。
9. PDF 缺失/替换后仍跳到可能错误的位置。
10. AI 在用户接受前修改正文。
11. Grounded 模式为模型伪造来源生成有效标签。
12. 证据不足时仍显示确定性结论。
13. 发送前清单与实际 transport payload 不一致。
14. local-only 模式产生任何非 loopback 请求。
15. API Key 或 Authorization 出现在 renderer、日志、备份或审计。
16. 项目之间出现证据、聊天、引用或审计串库。
17. 任意越权文件访问、路径穿越或 SSRF。
18. 安装包依赖 CDN 才能启动或使用核心本地功能。
19. release smoke 10 次中任一次失败。
20. 数据完整性终检任一 error 指标非零，或合法降级项未声明/不可定位。
21. 高危运行时依赖漏洞无书面、限期和可复核的豁免。
22. 无法验证的项目被报告为已通过。

---

## 19. 最终交付物

执行 AI 最终必须提供：

1. 完整代码和依赖锁文件。
2. 更新后的 README.md 和 AGENTS.md。
3. 数据 schema 与 migration 文档。
4. 用户可见的版本历史、备份恢复、引用、证据、AI 审计和矩阵使用说明。
5. 以下机器产物：

~~~text
artifacts/quality-summary.json
artifacts/coverage/lcov.info
artifacts/migration-matrix.json
artifacts/crash-matrix.json
artifacts/ipc-fuzz.json
artifacts/integrity-report.json
artifacts/perf-baseline.json
artifacts/offline-network-trace.json
artifacts/package-asset-manifest.json
artifacts/dependency-audit.json
artifacts/sbom.json
artifacts/a11y/
artifacts/release-evidence.json
artifacts/e2e/
artifacts/screenshots/
~~~

6. app.asar、portable、NSIS 的文件 SHA-256，以及 win-unpacked 的 canonical tree SHA-256。
7. 一份未通过项和残余风险清单。
8. 一份从旧版升级、回滚和恢复备份的操作说明。

每次 gate:release 必须生成唯一 buildRunId，并定义四类不可混用的绑定值：

- sourceTreeSha256：对本次输入源码清单计算的 canonical tree hash。清单排除 node_modules、dist、artifacts 和临时文件，包含相对 POSIX 路径、文件字节数和每文件 SHA-256，按相对路径升序，以 UTF-8/LF 序列化后再做 SHA-256；dirty/untracked 文件只要参与构建就必须纳入清单。
- appPayloadSha256：本次构建公共 `resources/app.asar` 文件的 SHA-256。win-unpacked、portable 解包结果和 NSIS 安装结果中的 app.asar 必须与它一致。
- targetArtifactSha256：portable 与 NSIS 使用各自文件 SHA-256；两个目标的 hash 必然可以不同。
- winUnpackedTreeSha256：win-unpacked 是目录，不伪装成单文件 hash；对其全部相对路径、文件字节数和文件 SHA-256 按上述 canonical tree manifest 规则计算。

release-evidence.json 必须由 verify:evidence 生成而非人工填写，并至少包含：

- schemaVersion、buildRunId、sourceTreeSha256、source tree manifest hash、已知 dirty/untracked 清单。
- package-lock、fixture、coverage baseline 的 SHA-256。
- Node、npm、Electron、OS 和测试机信息。
- 每条命令、退出码、开始/结束时间和原始 TAP/JUnit 报告 hash。
- appPayloadSha256、winUnpackedTreeSha256，以及 portable/NSIS 各自的 targetArtifactSha256。
- 每份 migration/crash/ipc/integrity/perf/offline/E2E 报告的 SHA-256。

所有 release E2E、性能、离线和安装报告必须引用同一个 buildRunId、sourceTreeSha256 和 appPayloadSha256，并另行记录实际被测的 target、targetArtifactSha256 或 winUnpackedTreeSha256；一份报告测试多个目标时逐项记录。复用旧报告、公共 payload 不一致、目标 hash 写错或报告与实际安装结果不一致时 verify:evidence 必须失败。artifacts 只使用合成 fixture，不得包含用户真实 profile、API Key 或未发表正文。

---

## 20. 执行 AI 最终回复模板

执行 AI 不得只回复“已完成”。最终回复必须使用以下结构：

~~~text
总体结论：通过 / 部分通过 / 不通过
最后通过的里程碑：M?

已完成：
- ...

未完成或阻塞：
- 验收编号：
- 原因：
- 用户影响：
- 需要的外部条件：

验证命令：
- 命令：
- 退出码：
- 关键结果：
- 产物路径：

数据完整性：
- verify:data 摘要：
- migration matrix：
- crash matrix：

性能：
- 测试环境：
- p50/p95/max：
- 与 baseline 的变化：

打包：
- win-unpacked smoke：
- offline smoke：
- portable/NSIS：
- SHA-256：

残余风险：
- ...
~~~

只有在 M0-M5、gate:release、全部最终 E2E、数据完整性终检和一票否决检查都通过时，总体结论才能写“通过”。
