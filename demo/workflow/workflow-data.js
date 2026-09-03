window.WORKFLOW_DATA = {
  "schemaVersion": 1,
  "id": "agent-harness-strategy-deck",
  "version": "1.0.0",
  "name": "Agent Harness 平台建设战略汇报 PPT",
  "objective": "从零用 pptxgenjs 产出一份可供高层会议直接使用的《从 Agent Demo 到可靠数字员工：企业级 Agent Harness 平台建设战略方案》.pptx，覆盖背景与问题、现状痛点、Harness 定义与分层架构、平台能力地图、自建/开源对比、投入产出与商业模式、12~18 个月路线图、组织与治理、风险与对策、决策请求与里程碑，并按 pptx Skill 完成内容、文件、逐页视觉三重 QA 与明确交付路径。",
  "source": "generated",
  "skill": {
    "name": "pptx",
    "hash": "a7ff03e2c85b636f55232a6b1555f5dd90216b7a1a359ab289d8364e6acbc6a0"
  },
  "globalBudget": {
    "mode": "unbounded"
  },
  "staff": {
    "core": [
      {
        "id": "staff-workflow-architect",
        "version": "1.0.0",
        "hash": "993cfc8b4191b7ee39304c68146e1e540095cc460bba87aa129ab494a50c298e"
      },
      {
        "id": "staff-delivery-governor",
        "version": "1.0.0",
        "hash": "36df7b44181caec9806ab7f8a50a4211cddc9b42db1c7d2a2045393b3c59f6aa"
      },
      {
        "id": "staff-quality-governor",
        "version": "1.0.0",
        "hash": "76d00e0c274a657341037016a0082ff477190cb69ff3f47d0925dccffe61895f"
      }
    ]
  },
  "acceptanceCriteria": [
    {
      "id": "ac-pptx-deliverable-exists",
      "description": "交付目录中存在一个可从零重建的 .pptx 汇报文件（由 pptxgenjs 生成脚本产出），文件可被 Office/LibreOffice 正常打开，且交付回报中给出明确的绝对文件路径与生成脚本路径。"
    },
    {
      "id": "ac-executive-decision-outline-coverage",
      "description": "Deck 完整覆盖任务要求的十个业务域：背景与问题、现状痛点、Harness 定义与分层架构、平台能力地图、与自建/开源方案对比、投入产出与商业模式、12~18 个月路线图、组织与治理、风险与对策、决策请求与里程碑；且整体论证服务于一个管理层决策问题（是否在未来 12~18 个月投入建设统一 Agent Harness 平台及如何建设），而非 Agent 科普。"
    },
    {
      "id": "ac-pptxgenjs-skill-contract-compliance",
      "description": "生成脚本符合 pptx Skill 的全部 gotchas 契约：在加页面前设置 pres.layout；颜色十六进制不带 # 且不内嵌 alpha；shadow offset >= 0 且每次调用新建 shadow 选项对象；bullet 用 breakLine + paraSpaceAfter（避免 bullet 前导间距）；图表使用原生 addChart 且带标题、数据标签、色板与网格设置，非位图截图；不使用不支持的 gradient 填充；每个输出文件一个 pptxgen 实例；letterSpacing 使用 charSpacing 替代；文本框 margin:0 用于对齐场景。"
    },
    {
      "id": "ac-executive-visual-system-applied",
      "description": "全 deck 落实视觉系统契约：一套贴合企业级平台战略主题的主导色板（含 60-70% 主色权重、1-2 支撑色、1 强调色）、深浅背景“三明治”结构（标题页与结论/决策页为深色背景）、字号层级符合 Skill 表格（标题 36-44pt、区块标题 20-24pt、正文 14-16pt、说明 10-12pt）、0.5\" 安全边距与一致的间距节奏、页面版式多样化（至少使用两栏、图标+文字行、网格卡片、大数字 callout、对比列、时间线/流程图等多种布局）。"
    },
    {
      "id": "ac-no-boring-or-ai-slop-pages",
      "description": "每一页都含至少一个视觉元素（图形、图标、图表、数据大字、时间线、对比列、表格或结构化卡片），不存在纯文字要点页；不存在被禁止的 AI 味装饰：无标题下划线色条、无页宽 header/footer 装饰条、无边饰条、无米色/奶油色默认背景；正文左对齐，仅标题居中。"
    },
    {
      "id": "ac-claim-grounding-and-data-integrity",
      "description": "Deck 中所有定量主张（成本、效率提升、市场规模、ROI、人力投入、里程碑日期等）均可追溯到冻结研究 Artifact 中的来源或明确标注为本方案假设/目标；图表忠实于数据比例与单位，标注来源、口径与不确定性；不存在无来源的夸张表述或被编造的精确数字。"
    },
    {
      "id": "ac-qa-triple-pass-evidence",
      "description": "Skill 规定的三重 QA 全部执行且留痕：(1) markitdown 内容检查，含占位符 grep（x{3,}|lorem|ipsum|TODO|[insert|This.*page.*layout）无残留命中；(2) python scripts/office/validate.py 在 /home/nepham/Agent/pi 工作目录对最终 .pptx 校验通过、零遗留失败；(3) soffice 转 PDF + pdftoppm 出图后逐页视觉检查，记录并修复文本溢出/截断、元素重叠、间距失衡、低对比度、版式错位等缺陷后重渲染确认。"
    }
  ],
  "nodes": [
    {
      "id": "research-evidence-pack",
      "objective": "产出《企业级 Agent Harness 平台》决策证据包（Markdown + JSON 双份），作为后续叙事、数据与视觉的唯一事实来源。必须覆盖：(1) 企业 Agent 从 Demo 到生产的普遍失败模式（不可观测、不可控权限、上下文/记忆断裂、工具调用不稳定、评测缺失、成本失控、无法复用）；(2) \"Agent Harness / Agent 运行时底座\" 的业界定义与分层职责（模型接入、工具/上下文编排、记忆、执行沙箱、评测与回归、观测与追踪、成本与配额治理、权限与安全、编排与生命周期、平台 SDK）；(3) 自建 vs 开源框架 vs 云厂商托管方案的真实对比维度与已知局限；(4) 平台化投入产出的可引用证据：工程师人效、复用率、事故率、推理成本治理收益、交付周期变化，逐条给出来源、时间范围、口径与置信度；(5) 治理与组织证据（平台团队形态、内部产品化、SLO/评测门禁）。明确区分【已证实】【单一来源】【存在争议】【推断/本方案假设】【未知/证据缺口】，所有无法证实的数字必须显式标注为缺口而非编造。同时输出面向 12~18 个月决策的结论要点列表，每条要点绑定证据条目 ID。",
      "agentCardRef": {
        "hash": "6781a21eed320f5165b47fd9d41b86f9ec7f97af1af902b1067f86bd9aea2ed8",
        "id": "research-synthesist",
        "version": "1.0.0"
      },
      "requiredCapabilities": [
        "research",
        "evidence-synthesis",
        "source-evaluation",
        "claim-tracing"
      ],
      "knowledgeBaseRefs": [
        "run-evidence-space"
      ],
      "dependsOn": [],
      "inputs": [],
      "output": {
        "artifactType": "research-evidence-pack",
        "businessPurpose": "为管理层投入决策提供可审计的事实与数字底座，防止 Deck 出现无来源的量化主张",
        "description": "结构化证据包：evidence.json（条目含 id/claim/source_type/source_ref/date_scope/confidence/limits）、evidence-notes.md（按 10 个业务域组织的综合）、open-questions.md（证据缺口与不可验证项）、claim-index.json（拟用于 Deck 的关键主张→证据 ID 映射）",
        "id": "harness-research-pack"
      },
      "tools": [
        "read",
        "grep",
        "find",
        "write",
        "web_search",
        "fetch_content",
        "source_check"
      ],
      "permissions": {
        "externalActions": true,
        "readScopes": [
          "."
        ],
        "workspace": "write",
        "writeScopes": [
          "outputs/research"
        ]
      },
      "budget": {
        "mode": "unbounded"
      },
      "rework": {
        "targetNodeId": "research-evidence-pack",
        "maxAttempts": 10
      },
      "routes": {
        "blocked": "staff",
        "exhausted": "user"
      },
      "kind": "execution",
      "skills": [
        "pptx"
      ],
      "gate": {
        "aggregation": {
          "conflict": "staff_arbitration",
          "requiredMechanical": "all",
          "requiredSemantic": "all"
        },
        "id": "gate-research-evidence",
        "mechanicalCriteria": [
          {
            "checkId": "artifact-integrity",
            "description": "证据包文件存在、可解析、结构完整：evidence.json 与 claim-index.json 为合法 JSON，evidence-notes.md 与 open-questions.md 非空",
            "id": "mech-research-artifacts-intact",
            "requiredEvidence": [
              "outputs/research/evidence.json 可被 JSON 解析且每条条目含 id/claim/source_type/confidence 字段",
              "outputs/research/claim-index.json 中每条 claim 至少绑定一个 evidence id",
              "outputs/research/evidence-notes.md 与 open-questions.md 存在且非空"
            ],
            "parameters": {}
          }
        ],
        "objectiveCoverage": [
          "ac-claim-grounding-and-data-integrity"
        ],
        "reviewers": [
          {
            "capabilities": [
              "evidence-review",
              "specification-conformance",
              "risk-identification"
            ],
            "id": "evidence-reviewer",
            "minCount": 1
          }
        ],
        "routes": {
          "blocked": "staff",
          "escalate": "staff",
          "pass": "narrative-deck-blueprint",
          "rework": "research-evidence-pack"
        },
        "semanticCriteria": [
          {
            "description": "Deck 将使用的每条关键量化主张（成本、人效、交付周期、复用率、事故率、市场规模等）都能定位到 evidence.json 中的条目、来源类型与口径；无来源的数字必须显式标注为“本方案假设/目标”而非既成事实",
            "evidenceRequirements": [
              "抽取 claim-index.json 中不少于 10 条关键主张并回查 evidence.json 条目与 source_ref",
              "列出任何无法回溯到来源的数字及其标注方式"
            ],
            "id": "sem-claims-traceable-to-sources",
            "required": true,
            "reviewerCapabilities": [
              "evidence-review"
            ]
          },
          {
            "description": "证据分级诚实：明确区分已证实/单一来源/存在争议/推断/未知，二手来源循环引用只计一条证据链，且 open-questions.md 真实记录缺口而非为空或写成免责声明",
            "evidenceRequirements": [
              "置信度分布抽样与至少 3 处原文交叉核对",
              "open-questions.md 中缺口条目与实际检索结果一致性检查"
            ],
            "id": "sem-confidence-and-gap-honesty",
            "required": true,
            "reviewerCapabilities": [
              "risk-identification"
            ]
          },
          {
            "description": "证据覆盖面满足决策需要：10 个业务域（背景问题、痛点、Harness 定义与分层、能力地图、自建/开源对比、ROI 与商业模式、12~18 月路线图、组织治理、风险对策、决策请求）均有可用证据，不存在某域完全空缺",
            "evidenceRequirements": [
              "逐域标注证据条数与最弱环节",
              "指出不足以支撑管理层决策的域"
            ],
            "id": "sem-decision-coverage-completeness",
            "required": true,
            "reviewerCapabilities": [
              "specification-conformance"
            ]
          }
        ]
      }
    },
    {
      "agentCardRef": {
        "hash": "e01d5d40eaba54c0109b9eb94bad6ec0cc47b95199b46a79b0264908a8e01ad7",
        "id": "narrative-architect",
        "version": "1.0.0"
      },
      "budget": {
        "mode": "unbounded"
      },
      "dependsOn": [
        "research-evidence-pack"
      ],
      "id": "narrative-deck-blueprint",
      "inputs": [
        {
          "artifactType": "research-evidence-pack",
          "fromNodeId": "research-evidence-pack",
          "name": "harness-evidence",
          "required": true
        }
      ],
      "knowledgeBaseRefs": [
        "accepted-content-evidence"
      ],
      "objective": "把证据包编译为可直接实施的 Deck 蓝本：一份面向 CTO / AI 平台负责人 / 研发管理负责人 / 业务负责人的决策叙事，核心问题是“未来 12~18 个月是否投入建设统一 Agent Harness 平台，以及如何建设”。必须产出：(a) outputs/content/deck-blueprint.md：完整分页规划，建议 18~24 页，逐页写明页码、页标题（<=12 字中文）、唯一主旨（一句话）、受众需要由此页做出的判断、页内具体文案（标题/小标题/正文短句/数据槽位/结论句，非空泛占位）、该页指定的视觉表达类型（两栏图文 / 图标+文字行 / 2x2 或 2x3 网格卡片 / 大数字 callout / 对比列 / 时间线或编号流程 / 原生图表 / 表格），且相邻页不得连续使用同一布局；(b) 十个必选业务域全部映射到具体页：背景与问题、现状痛点、Harness 定义与分层架构（至少 4~6 层分层图）、平台能力地图（按域分组的能力网格）、自建/开源/云托管三方案对比（含对比表与选型结论）、投入产出与商业模式（成本构成、收益来源、内部计费或价值归属、盈亏平衡逻辑）、12~18 个月分阶段路线图（阶段目标/交付物/里程碑/度量）、组织与治理（团队形态、平台产品化、评测与 SLO 门禁、权限与安全治理）、风险与对策（每条风险配缓解措施与信号）、决策请求与里程碑（明确的 go/no-go 请求、资源请求、时间点）；(c) outputs/content/slide-intent-map.json：逐页机器可读清单，含 dark/light 背景归属（标题页、章节页与结论页深色，内容页浅色的三明治结构）、文案键、数据槽位标识（供数据节点填充）、视觉元素类型、所需图表类型（原生 pptx chart / 分层图 / 时间线 / 表格 / 图标网格）；(d) outputs/content/data-requests.md：需要定量计算或图表化的内容清单与口径要求。所有数字主张必须引用 evidence.json 的条目 ID 或明确标记为“本方案假设/目标”，不得发明未验证事实；保留证据中的限定条件、争议与不确定性。",
      "output": {
        "artifactType": "deck-narrative-blueprint",
        "businessPurpose": "固定全 deck 的论证顺序、逐页文案与视觉类型选择，使实现与评审有唯一真相来源",
        "description": "outputs/content/deck-blueprint.md（逐页完整文案与主旨）、outputs/content/slide-intent-map.json（逐页视觉类型/背景明暗/数据槽位）、outputs/content/data-requests.md（定量与图表需求清单）",
        "id": "deck-blueprint-package"
      },
      "permissions": {
        "externalActions": false,
        "readScopes": [
          ".",
          "outputs/research"
        ],
        "workspace": "write",
        "writeScopes": [
          "outputs/content"
        ]
      },
      "requiredCapabilities": [
        "narrative-design",
        "information-architecture",
        "technical-communication",
        "audience-adaptation"
      ],
      "rework": {
        "targetNodeId": "narrative-deck-blueprint",
        "maxAttempts": 10
      },
      "routes": {
        "blocked": "staff",
        "exhausted": "user"
      },
      "tools": [
        "read",
        "write"
      ],
      "kind": "execution",
      "skills": [
        "pptx"
      ],
      "gate": {
        "aggregation": {
          "conflict": "staff_arbitration",
          "requiredMechanical": "all",
          "requiredSemantic": "all"
        },
        "id": "gate-narrative-blueprint",
        "mechanicalCriteria": [
          {
            "checkId": "artifact-integrity",
            "description": "蓝本三件文件存在且结构完整，slide-intent-map.json 可解析且逐页字段齐全",
            "id": "mech-blueprint-files-intact",
            "requiredEvidence": [
              "outputs/content/slide-intent-map.json 可 JSON 解析，每项含 page/title/visual_type/background_mode/data_slots/evidence_refs",
              "outputs/content/deck-blueprint.md 存在且逐页有页码与主旨，无空页描述",
              "deck-blueprint.md 与 slide-intent-map.json 页码集合一致"
            ],
            "parameters": {}
          },
          {
            "checkId": "artifact-integrity",
            "description": "十个必选业务域在蓝本中均被显式映射到具体页码",
            "id": "mech-ten-domains-present",
            "requiredEvidence": [
              "逐个列出背景问题/痛点/Harness定义与分层/能力地图/自建开源对比/投入产出与商业模式/12~18月路线图/组织治理/风险对策/决策请求对应的页码",
              "确认分层架构、对比表、路线图时间线、网格能力地图均有对应 visual_type"
            ],
            "parameters": {}
          }
        ],
        "objectiveCoverage": [
          "ac-executive-decision-outline-coverage",
          "ac-claim-grounding-and-data-integrity"
        ],
        "reviewers": [
          {
            "capabilities": [
              "readability-review",
              "inclusive-design-review"
            ],
            "id": "accessibility-reviewer",
            "minCount": 1
          },
          {
            "capabilities": [
              "quality-governance",
              "risk-governance"
            ],
            "id": "staff-quality-governor",
            "minCount": 1
          }
        ],
        "routes": {
          "blocked": "staff",
          "escalate": "staff",
          "pass": "quant-model-chart-spec",
          "rework": "narrative-deck-blueprint"
        },
        "semanticCriteria": [
          {
            "description": "蓝本以管理层决策为主线而非 Agent 科普：存在明确的前提-冲突-证据-结论链，且在决策请求页可回答“是否投、投多少、分成几步、何时复核、不投的代价”",
            "evidenceRequirements": [
              "引用蓝本逐页主旨列出的决策链",
              "指出任何仅做概念解释而不支撑决策的页"
            ],
            "id": "sem-decision-first-arc",
            "required": true,
            "reviewerCapabilities": [
              "quality-governance"
            ]
          },
          {
            "description": "受众分层到每页：CTO（架构与技术风险）、AI 平台负责人（能力地图与治理）、研发管理（人效与交付）、业务负责人（成本/收益/商业模式）均能看到与其判断相关的页面，文案粒度适合会议口述而非长段落",
            "evidenceRequirements": [
              "按四类受众抽样 3 页判断其可用价值",
              "列出文案密度过高或术语未解释的页"
            ],
            "id": "sem-audience-fit-per-page",
            "required": true,
            "reviewerCapabilities": [
              "inclusive-design-review"
            ]
          },
          {
            "description": "逐页文案具体可实施：每页只有一个信息任务，文案含真实可上屏句子与数据槽位，无占位词、无口号式结论、无重复结论；关键主张保留证据限定条件并引用 evidence ID 或标注为假设",
            "evidenceRequirements": [
              "抽查不少于 6 页的文案具体度",
              "核对主张与 evidence.json 条目的引用一致性"
            ],
            "id": "sem-actionable-copy-and-evidence-binding",
            "required": true,
            "reviewerCapabilities": [
              "risk-governance"
            ]
          },
          {
            "description": "视觉类型分配可落地且不单调：相邻页版式不重复，每页至少一种非纯文字表达（分层图/图表/时间线/对比列/网格/大数字/图标行），图表需求已标记为原生 chart 或结构化图形",
            "evidenceRequirements": [
              "输出逐页 visual_type 序列并标出连续重复",
              "确认无纯文字要点页"
            ],
            "id": "sem-layout-variety-and-visual-coverage",
            "required": true,
            "reviewerCapabilities": [
              "readability-review"
            ]
          }
        ]
      }
    },
    {
      "agentCardRef": {
        "hash": "992825c25a596a191841afd3b0ec0bdfd69be92af7e0c15b7cf0eac22401fb19",
        "id": "data-visualization-engineer",
        "version": "1.0.0"
      },
      "budget": {
        "mode": "unbounded"
      },
      "dependsOn": [
        "narrative-deck-blueprint",
        "research-evidence-pack"
      ],
      "id": "quant-model-chart-spec",
      "inputs": [
        {
          "artifactType": "deck-narrative-blueprint",
          "fromNodeId": "narrative-deck-blueprint",
          "name": "deck-blueprint",
          "required": true
        },
        {
          "artifactType": "research-evidence-pack",
          "fromNodeId": "research-evidence-pack",
          "name": "harness-evidence",
          "required": true
        }
      ],
      "knowledgeBaseRefs": [
        "run-data-sources"
      ],
      "objective": "把蓝本中的定量需求变成可复算、可上屏的数据模型与图表规格（与视觉系统节点并行，不得依赖颜色十六进制值）。必须产出：(1) outputs/data/deck-data-model.json：逐页数据槽位（key 与 slide-intent-map.json 中 data_slots 一一对应）的值、单位、口径、时间范围、来源类型（evidence ID 引用 或 本方案假设/目标）、推导方法、不确定性说明；(2) outputs/data/roi-model.mjs：可 node 运行的自建/开源/统一 Harness 平台三方案 12~18 个月 TCO 与收益模型（工程师人时、平台研发投入、重复建设浪费、推理与基础设施成本、事故与返工成本、复用收益），参数集中在一个 PARAMS 对象内并标注来源/假设，脚本输出 outputs/data/roi-output.json 与可读的 roi-report.md；(3) outputs/data/chart-specs.md：每个需图表化的槽位给出 PowerPoint 原生图表规格——图表类型（column/bar/line/pie 等）、系列与类别数组（与 roi-output.json 一致）、轴与单位、是否需要次轴（如需次轴必须同时声明 valAxes 与 catAxes 两个条目）、数据标签位置（stacked bar/column 仅允许 ctr/inEnd/inBase）、图例取舍、以及从语义色角色名取值的配色（必须仅使用这些角色名：palettePrimary, paletteSecondary, paletteAccent, paletteAlert, paletteMuted, textOnDark, textOnLight）；(4) outputs/data/comparison-matrix.md：自建 vs 开源框架 vs 云托管在能力覆盖、治理、成本、锁定风险、演进可控性、时间成本上的对比表内容（含推荐结论与不推荐项的明确理由）；(5) outputs/data/roadmap-data.md：12~18 个月分阶段路线图的阶段名称、起止月份、每阶段交付物、验收度量、里程碑日期，可直接被时间线渲染。禁止发明数据：无法从证据支撑的数字必须在 deck-data-model.json 中标记 isAssumption=true 并给出敏感性区间；在 roi-report.md 中把观察到的事实与解释性结论分开陈述。",
      "output": {
        "artifactType": "deck-data-model",
        "businessPurpose": "为投入产出、对比、能力地图与路线图页提供可复算的口径与原生图表规格，保证管理层数字可被追问",
        "description": "outputs/data/deck-data-model.json（逐槽位数值+口径+来源/假设标记）、roi-model.mjs + roi-output.json + roi-report.md（三方案 TCO/收益模型与敏感性）、chart-specs.md（原生 pptx 图表规格，使用语义色角色名）、comparison-matrix.md、roadmap-data.md",
        "id": "deck-data-package"
      },
      "permissions": {
        "externalActions": false,
        "readScopes": [
          ".",
          "outputs/content",
          "outputs/research"
        ],
        "workspace": "write",
        "writeScopes": [
          "outputs/data"
        ]
      },
      "requiredCapabilities": [
        "data-visualization",
        "quantitative-analysis",
        "chart-design",
        "data-provenance"
      ],
      "rework": {
        "targetNodeId": "quant-model-chart-spec",
        "maxAttempts": 10
      },
      "routes": {
        "blocked": "staff",
        "exhausted": "user"
      },
      "tools": [
        "read",
        "bash",
        "write"
      ],
      "kind": "execution",
      "skills": [
        "pptx"
      ],
      "gate": {
        "aggregation": {
          "conflict": "staff_arbitration",
          "requiredMechanical": "all",
          "requiredSemantic": "all"
        },
        "id": "gate-quant-model-chart-spec",
        "mechanicalCriteria": [
          {
            "checkId": "artifact-integrity",
            "description": "数据模型与图表规格文件存在且结构完整，槽位键与蓝本一一对应",
            "id": "mech-data-files-intact",
            "requiredEvidence": [
              "outputs/data/deck-data-model.json 可 JSON 解析，key 集合覆盖 slide-intent-map.json 中所有声明的 data_slots",
              "每条槽位含 value/unit/basis/sourceRefs 或 evidenceIds/isAssumption 字段",
              "outputs/data/comparison-matrix.md 与 roadmap-data.md 非空"
            ],
            "parameters": {}
          },
          {
            "checkId": "artifact-integrity",
            "description": "ROI 模型可确定性重跑，产出与报告一致",
            "id": "mech-roi-model-reruns",
            "requiredEvidence": [
              "记录 node outputs/data/roi-model.mjs 的实际执行命令与退出码为 0",
              "比对 roi-output.json 与 roi-report.md 中同一个关键数字（三方案 18 个月 TCO、盈亏平衡点）完全一致",
              "roi-model.mjs 中 PARAMS 每项均标注来源或 isAssumption"
            ],
            "parameters": {}
          }
        ],
        "objectiveCoverage": [
          "ac-claim-grounding-and-data-integrity",
          "ac-executive-decision-outline-coverage",
          "ac-pptxgenjs-skill-contract-compliance"
        ],
        "reviewers": [
          {
            "capabilities": [
              "evidence-review",
              "specification-conformance",
              "risk-identification"
            ],
            "id": "evidence-reviewer",
            "minCount": 1
          },
          {
            "capabilities": [
              "software-verification",
              "test-design",
              "failure-reproduction"
            ],
            "id": "verification-engineer",
            "minCount": 1
          },
          {
            "capabilities": [
              "readability-review",
              "inclusive-design-review"
            ],
            "id": "accessibility-reviewer",
            "minCount": 1
          }
        ],
        "routes": {
          "blocked": "staff",
          "escalate": "staff",
          "pass": "pptxgenjs-deck-build",
          "rework": "quant-model-chart-spec"
        },
        "semanticCriteria": [
          {
            "description": "数字可审计：每个上屏定量值要么引用 evidence ID，要么显式标记为方案假设并给出敏感性区间；无凭空精确数字，无将目标写成现状",
            "evidenceRequirements": [
              "抽样 ≥ 8 个槽位回查来源或假设标记",
              "核对 isAssumption=true 项均含区间或保守/激进情景"
            ],
            "id": "sem-number-provenance",
            "required": true,
            "reviewerCapabilities": [
              "evidence-review"
            ]
          },
          {
            "description": "ROI/TCO 模型逻辑成立且口径一致：成本项不重不漏（研发、推理/基础设施、重复建设浪费、事故返工、治理运维），时间范围与 12~18 个月决策窗口一致，收益口径不被双重计算",
            "evidenceRequirements": [
              "复算至少两个情景的总计与差值",
              "指出任何循环论证或隐含假设"
            ],
            "id": "sem-roi-model-soundness",
            "required": true,
            "reviewerCapabilities": [
              "risk-identification"
            ]
          },
          {
            "description": "图表规格忠于数据且符合 pptx Skill 约束：图形选择匹配比较任务，轴与比例不夸大差异，单位与不确定性有标注，使用原生图表而非位图，次轴声明完整、堆叠柱标签位置合法",
            "evidenceRequirements": [
              "逐项核对 chart-specs.md 与 roi-output.json 数组一致",
              "检查是否存在用 outEnd 于堆叠柱或未同时声明 valAxes+catAxes 的次轴组合"
            ],
            "id": "sem-chart-faithfulness-and-spec-legal",
            "required": true,
            "reviewerCapabilities": [
              "software-verification"
            ]
          },
          {
            "description": "图形可读性与包容性：色彩仅使用约定的语义角色名且不仅仅靠颜色区分含义，标签不依赖极小字号，关键差异有文字解释，色弱读者与后排投影环境仍可读出结论",
            "evidenceRequirements": [
              "指出仅靠颜色传递信息的图表及替代编码建议",
              "检查最小字号与标签密度"
            ],
            "id": "sem-chart-readability",
            "required": true,
            "reviewerCapabilities": [
              "readability-review"
            ]
          }
        ]
      }
    },
    {
      "agentCardRef": {
        "hash": "a163ffcfe2dcb3b65adde9ddc9f04bb1cc17615306d0d2f281c49eff0b62a8c5",
        "id": "visual-system-designer",
        "version": "1.0.0"
      },
      "budget": {
        "mode": "unbounded"
      },
      "dependsOn": [
        "narrative-deck-blueprint"
      ],
      "id": "visual-system-design",
      "inputs": [
        {
          "artifactType": "deck-narrative-blueprint",
          "fromNodeId": "narrative-deck-blueprint",
          "name": "deck-blueprint",
          "required": true
        }
      ],
      "knowledgeBaseRefs": [
        "run-design-context"
      ],
      "objective": "为本 deck 建立一套专属于“企业级 AI 基础设施战略”主题、可被 pptxgenjs 严格实现的视觉系统契约（与数据节点并行，不依赖具体数值）。必须产出 outputs/design/visual-contract.md 与 outputs/design/design-tokens.json，内容包含：(1) 色板：一套主导色 + 1~2 支撑色 + 1 强调色（十六进制不带 # 且不含 alpha 通道，全部写入 token 的语义角色名，必须包含 palettePrimary, paletteSecondary, paletteAccent, paletteAlert, paletteMuted, surfaceDark, surfaceLight, textOnDark, textOnLight, mutedText），并规定 60-70% 主视觉重量归属，禁止使用米色/奶油色背景默认值，内容页背景为纯白或极浅冷灰；(2) 字体与字号层级：仅从 Skill 安全列表中选择正文与标题字体（如 Cambria/Bookman Old Style/Century Schoolbook 作衬线标题 + Calibri/Arial 作正文），规定标题 36-44pt、区块标题 20-24pt、正文 14-16pt、说明 10-12pt，并标注哪些元素可用 QA 不可靠字体（仅标题且需留 ~10% 余量）；(3) 构图语法库：为蓝本中出现的每种页型给出可执行版式坐标规则（在 Skill 默认 16x9 = 10\"x5.625\" 与 LAYOUT_WIDE = 13.3\"x7.5\" 中明确选定一个并写死），含安全边距 >=0.5\"、统一间距（0.3\" 或 0.5\" 二选一并规定使用场景）、每页至少一个视觉元素的规定；(4) 视觉母题：选定一个可贯穿全 deck 的识别元素（如带圆角半径的分层架构卡片 + 圆形图标底托），并明确禁止：标题下划线色条、页宽 header/footer 装饰条、卡片边缘饰条、作为装饰的侧边竖纹；(5) 深浅“三明治”规则：标题页、章节页、决策/结论页使用 surfaceDark，内容页使用 surfaceLight，给出深色页上文字/图标对比度最低要求；(6) 图表与卡片样式规范：原生图表配色取自 token 角色、网格与坐标轴样式、数据标签位置，阴影规则（offset >= 0，向上投影用 angle 270 且每次调用新建 shadow 对象），圆角矩形仅用 rectRadius on ROUNDED_RECTANGLE，透明度仅用 transparency/opacity 且不得把 alpha 写入 hex；(7) 实现交接：把上述每条规则编号（V-01…），以便构建节点与 QA 节点逐条验收。禁止把叙事、数字口径或数据本身重新定义。",
      "output": {
        "artifactType": "visual-system-contract",
        "businessPurpose": "给构建与 QA 提供唯一、可机械核对的视觉系统规则，保证战略汇报的专业观感且避免 AI 味装饰",
        "description": "outputs/design/visual-contract.md（编号规则 V-01…V-nn，含禁用装饰清单与页型版式规则）与 outputs/design/design-tokens.json（语义色名→十六进制、字体、字号、间距、圆角、阴影、图表样式 token）",
        "id": "deck-visual-contract"
      },
      "permissions": {
        "externalActions": false,
        "readScopes": [
          ".",
          "outputs/content"
        ],
        "workspace": "write",
        "writeScopes": [
          "outputs/design"
        ]
      },
      "requiredCapabilities": [
        "visual-system",
        "design-tokens",
        "visual-hierarchy",
        "brand-consistency",
        "accessible-design"
      ],
      "rework": {
        "targetNodeId": "visual-system-design",
        "maxAttempts": 10
      },
      "routes": {
        "blocked": "staff",
        "exhausted": "user"
      },
      "tools": [
        "read",
        "write"
      ],
      "kind": "execution",
      "skills": [
        "pptx"
      ],
      "gate": {
        "aggregation": {
          "conflict": "staff_arbitration",
          "requiredMechanical": "all",
          "requiredSemantic": "all"
        },
        "id": "gate-visual-system-design",
        "mechanicalCriteria": [
          {
            "checkId": "artifact-integrity",
            "description": "视觉契约与 token 文件存在且机器可读，必需 token 角色齐全且十六进制合法",
            "id": "mech-token-file-complete",
            "requiredEvidence": [
              "outputs/design/design-tokens.json 可 JSON 解析，含 palettePrimary/paletteSecondary/paletteAccent/paletteAlert/paletteMuted/surfaceDark/surfaceLight/textOnDark/textOnLight/mutedText 全部角色",
              "所有颜色值为 6 位十六进制且不带 # 与 alpha",
              "outputs/design/visual-contract.md 存在编号规则（V-01 起连续无缺口）"
            ],
            "parameters": {}
          },
          {
            "checkId": "artifact-integrity",
            "description": "契约为 pptxgenjs 可实现的确定参数（画布布局、字号、间距、字体名）而非模糊描述",
            "id": "mech-contract-implementable",
            "requiredEvidence": [
              "visual-contract.md 明确写出选定 layout（LAYOUT_16x9 或 LAYOUT_WIDE）与英寸坐标约束",
              "字号规则落在 Skill 要求范围内（标题 36-44 / 区块 20-24 / 正文 14-16 / 说明 10-12）",
              "字体名均来自 Skill 安全列表或被标记为需留余量的标题字体"
            ],
            "parameters": {}
          }
        ],
        "objectiveCoverage": [
          "ac-executive-visual-system-applied",
          "ac-no-boring-or-ai-slop-pages",
          "ac-pptxgenjs-skill-contract-compliance"
        ],
        "reviewers": [
          {
            "capabilities": [
              "accessibility-review",
              "artifact-review",
              "readability-review"
            ],
            "id": "accessibility-reviewer",
            "minCount": 1
          },
          {
            "capabilities": [
              "artifact-review",
              "specification-conformance"
            ],
            "id": "evidence-reviewer",
            "minCount": 1
          }
        ],
        "routes": {
          "blocked": "staff",
          "escalate": "staff",
          "pass": "pptxgenjs-deck-build",
          "rework": "visual-system-design"
        },
        "semanticCriteria": [
          {
            "description": "色板贴合主题且主导关系明确：一看就是企业级 AI 基础设施战略汇报而非通用蓝模板，一主色占 60-70% 视觉重量，无米色/奶油背景默认，深色页与浅色页分布成三明治结构",
            "evidenceRequirements": [
              "引用具体十六进制值与权重规则说明选色理由",
              "确认标题页、章节页、结论/决策页为深色且内容页为浅色"
            ],
            "id": "sem-palette-theme-fit",
            "required": true,
            "reviewerCapabilities": [
              "artifact-review"
            ]
          },
          {
            "description": "禁用装饰明确无歧义：契约显式禁止标题下划线色条、页宽 header/footer 装饰条、卡片边饰条、侧边竖纹，并未在任何页型规则中自相矛盾地引入它们",
            "evidenceRequirements": [
              "列出契约中页型规则与禁用清单交叉核对结果",
              "指出任何看似装饰条的规定"
            ],
            "id": "sem-anti-slop-rules-consistent",
            "required": true,
            "reviewerCapabilities": [
              "specification-conformance"
            ]
          },
          {
            "description": "对比度与可读性满足会议室投影环境：深色页文字/图标与背景有足够对比，正文不低于规定下限，图标圆圈不会变成低对比元素，无障碍不是末期补丁而是写在 token 层",
            "evidenceRequirements": [
              "对 textOnDark/surfaceDark 与 textOnLight/surfaceLight 给出对比度判断",
              "列出风险最高的三类元素"
            ],
            "id": "sem-contrast-and-legibility",
            "required": true,
            "reviewerCapabilities": [
              "accessibility-review"
            ]
          },
          {
            "description": "系统一致而非重复：同一视觉母题贯穿全 deck，但每种页型（分层图/能力网格/对比列/时间线/大数字/图表页）均有区分性版式规则，不会导致每页同一模板",
            "evidenceRequirements": [
              "比对蓝本 visual_type 清单与契约页型规则的一一对应情况",
              "指出缺规则的页型"
            ],
            "id": "sem-variation-within-system",
            "required": true,
            "reviewerCapabilities": [
              "readability-review"
            ]
          }
        ]
      }
    },
    {
      "agentCardRef": {
        "hash": "9a85a05b5d8174f1764fdcb9697a2edcc4fa9962ad9e8332e9c5c2416dd4c125",
        "id": "implementation-engineer",
        "version": "1.0.0"
      },
      "budget": {
        "mode": "unbounded"
      },
      "dependsOn": [
        "narrative-deck-blueprint",
        "quant-model-chart-spec",
        "visual-system-design"
      ],
      "id": "pptxgenjs-deck-build",
      "inputs": [
        {
          "artifactType": "deck-narrative-blueprint",
          "fromNodeId": "narrative-deck-blueprint",
          "name": "deck-blueprint",
          "required": true
        },
        {
          "artifactType": "deck-data-model",
          "fromNodeId": "quant-model-chart-spec",
          "name": "deck-data",
          "required": true
        },
        {
          "artifactType": "visual-system-contract",
          "fromNodeId": "visual-system-design",
          "name": "visual-contract",
          "required": true
        }
      ],
      "knowledgeBaseRefs": [
        "workspace-implementation"
      ],
      "objective": "在 /home/nepham/Agent/pi 下编写可重复执行的 pptxgenjs 生成器脚本，从零构建《从 Agent Demo 到可靠数字员工：企业级 Agent Harness 平台建设战略方案》.pptx，严格实现上游蓝本文案、数据模型与视觉契约，不自行改变叙事、数字口径或设计系统。要求：(1) 在添加任何页面前设定 pres.layout（与契约选定一致），每个输出文件使用新的 pptxgen 实例；(2) 所有颜色取自 design-tokens.json 的十六进制值（不带 #、不内嵌 alpha），需要透明时用 transparency/opacity；(3) 图表一律用原生 addChart（组合/次轴图必须同时声明 valAxes 与 catAxes 两条目；堆叠柱/条的数据标签位置仅用 ctr/inEnd/inBase），并设定标题、数据标签、色板与网格样式，不得退化为位图；(4) shadow offset 始终 >= 0，向上投影用 angle 270，且每次 add* 调用新建 shadow/options 对象（库会原地 mutate）；(5) 列表用 bullet:true + breakLine，靠 paraSpaceAfter 控制间距而非 lineSpacing，不得出现字面 • 字符；对齐时文本框 margin:0；rectRadius 仅用于 ROUNDED_RECTANGLE；不使用 gradient 填充；字间距用 charSpacing；(6) 逐页按蓝本 visual_type 实现不同版式（两栏图文、图标+圆形底托文字行、2x2/2x3 能力网格、大数字 callout、三方案对比列、分层架构堆叠卡片、12~18 个月时间线、风险矩阵等），每页至少一个视觉元素，禁止纯要点页；标题页/章节页/决策与结论页用深色背景，内容页浅色（三明治结构），正文左对齐；禁止任何标题下划线色条、页宽装饰条、卡片边饰条、侧边竖纹；(7) 按 Skill 要求用 slide.addNotes 写每页口述备注（不放文本框）；(8) 运行 node 生成脚本产出 outputs/delivery/agent-harness-strategy.pptx，自行执行一次 python scripts/office/validate.py 与 soffice 转 PDF + pdftoppm 出图，对发现的溢出/重叠就地修复生成器后重建，最多迭代三次并在构建说明中如实记录实际执行过的命令与结果；(9) 提交 scripts/build_deck.js（可拆分模块）、outputs/delivery/BUILD.md（记录构建命令、页码→规则映射、已知限制）。",
      "output": {
        "artifactType": "pptx-deck-candidate",
        "businessPurpose": "把已验收的叙事、数据与视觉系统确定性地编译为可上会的 .pptx 及其可重建来源，供独立 QA 与最终 Gate 评审",
        "description": "outputs/delivery/agent-harness-strategy.pptx（候选汇报文件，含完整十大业务域与逐页备注）、scripts/build_deck.js 及生成器模块（唯一真相来源）、outputs/delivery/BUILD.md（构建命令、token 消费方式、页码→视觉契约规则映射、自检发现与已修缺陷）",
        "id": "deck-candidate-package"
      },
      "permissions": {
        "externalActions": false,
        "readScopes": [
          ".",
          "outputs/content",
          "outputs/data",
          "outputs/design",
          "outputs/research",
          ".pi/skills/pptx"
        ],
        "workspace": "write",
        "writeScopes": [
          "outputs/delivery",
          "scripts"
        ]
      },
      "requiredCapabilities": [
        "software-implementation",
        "integration-engineering",
        "minimal-change",
        "debugging"
      ],
      "rework": {
        "targetNodeId": "pptxgenjs-deck-build",
        "maxAttempts": 10
      },
      "routes": {
        "blocked": "staff",
        "exhausted": "user"
      },
      "tools": [
        "read",
        "grep",
        "find",
        "edit",
        "write",
        "bash"
      ],
      "kind": "execution",
      "skills": [
        "pptx"
      ],
      "gate": {
        "aggregation": {
          "conflict": "staff_arbitration",
          "requiredMechanical": "all",
          "requiredSemantic": "all"
        },
        "id": "gate-pptxgenjs-deck-build",
        "mechanicalCriteria": [
          {
            "checkId": "artifact-integrity",
            "description": "候选 .pptx 包结构完整、可解压、幻灯片数量与蓝本页码一致且无占位残留",
            "id": "mech-deck-package-integrity",
            "requiredEvidence": [
              "outputs/delivery/agent-harness-strategy.pptx 存在且为合法 ZIP/OOXML，ppt/slides/slideN.xml 数量与 slide-intent-map.json 页数一致",
              "markitdown 输出中无 x{3,}/lorem/ipsum/TODO/[insert 类占位命中",
              "BUILD.md 中记录的构建命令与脚本路径一致且可复现"
            ],
            "parameters": {}
          },
          {
            "checkId": "artifact-integrity",
            "description": "官方校验脚本零失败通过",
            "id": "mech-validate-script-pass",
            "requiredEvidence": [
              "在 /home/nepham/Agent/pi 执行 python scripts/office/validate.py outputs/delivery/agent-harness-strategy.pptx 的输出原文（记录于 BUILD.md 或 QA 日志），无未修复失败项",
              "本任务为零从生成，应无 --original 且无遗留错误"
            ],
            "parameters": {}
          },
          {
            "checkId": "artifact-integrity",
            "description": "pptxgenjs Skill gotchas 静态合规（颜色、阴影、图表、布局）",
            "id": "mech-skill-gotcha-static-scan",
            "requiredEvidence": [
              "grep scripts/build_deck.js 确认无 #RRGGBB、无 8 位十六进制、无负 shadow offset、无 gradient 填充、字间距用 charSpacing 非 letterSpacing",
              "确认 addChart 使用处若含 secondaryValAxis/secondaryCatAxis 则同时声明 valAxes 与 catAxes 两条目，堆叠柱 dataLabelPosition 仅 ctr/inEnd/inBase",
              "确认在首次 addSlide 前已设 pres.layout，且每个输出文件使用新 pptxgen 实例"
            ],
            "parameters": {}
          }
        ],
        "objectiveCoverage": [
          "ac-pptx-deliverable-exists",
          "ac-pptxgenjs-skill-contract-compliance",
          "ac-no-boring-or-ai-slop-pages",
          "ac-executive-visual-system-applied"
        ],
        "reviewers": [
          {
            "capabilities": [
              "artifact-review",
              "evidence-review",
              "specification-conformance",
              "risk-identification"
            ],
            "id": "evidence-reviewer",
            "minCount": 1
          },
          {
            "capabilities": [
              "deterministic-build",
              "format-packaging",
              "artifact-production"
            ],
            "id": "artifact-production-engineer",
            "minCount": 1
          }
        ],
        "routes": {
          "blocked": "staff",
          "escalate": "staff",
          "pass": "deck-qa-verification",
          "rework": "pptxgenjs-deck-build"
        },
        "semanticCriteria": [
          {
            "description": "构建结果忠实于已验收的上游来源：逐页文案、数值、图表规格、颜色 token 均来自蓝本/数据模型/视觉契约，无擅自改写叙事、改数字或重定义设计系统",
            "evidenceRequirements": [
              "抽查 ≥ 6 页与 deck-blueprint.md、deck-data-model.json 的对应关系",
              "指出任何上游未出现的新主张或数字"
            ],
            "id": "sem-faithful-to-upstream",
            "required": true,
            "reviewerCapabilities": [
              "specification-conformance"
            ]
          },
          {
            "description": "版式多样性与每页视觉元素：实现确实使用了多种构图语法，每页至少含图形/图标/图表/大数字/时间线/对比列之一，且未退化为标题+纯要点；未使用被禁的装饰条/下划线色条/米色背景",
            "evidenceRequirements": [
              "输出逐页实际版式与视觉元素清单",
              "指出任何纯文字要点页或装饰条残留"
            ],
            "id": "sem-layout-realization",
            "required": true,
            "reviewerCapabilities": [
              "artifact-review"
            ]
          },
          {
            "description": "实现质量与可重建性：脚本结构清晰、token 与文案集中、无手工修补生成物、无死复制粘贴坐标导致的数据不一致；变更限于本任务范围（最小影响面）",
            "evidenceRequirements": [
              "阅读 scripts/build_deck.js 确认来源与参数集中管理",
              "检查是否存在对 .pptx 二进制/XML 的手工后修补"
            ],
            "id": "sem-build-engineering-quality",
            "required": true,
            "reviewerCapabilities": [
              "deterministic-build"
            ]
          },
          {
            "description": "残留风险与限制被如实记录：未执行的命令不得声称执行；自检发现的溢出/重叠与未修复项必须在 BUILD.md 中列出并交给 QA",
            "evidenceRequirements": [
              "比对自述构建日志与实际文件时间戳/产物",
              "列出仍待 QA 确认的风险点"
            ],
            "id": "sem-honest-build-selfreport",
            "required": true,
            "reviewerCapabilities": [
              "risk-identification"
            ]
          }
        ]
      }
    },
    {
      "agentCardRef": {
        "hash": "ff06a1e2fba8d98a8e43752f9d9a2964fc697ebc37f9924ea6d53a6a174fff41",
        "id": "verification-engineer",
        "version": "1.0.0"
      },
      "budget": {
        "mode": "unbounded"
      },
      "dependsOn": [
        "pptxgenjs-deck-build",
        "narrative-deck-blueprint",
        "visual-system-design",
        "quant-model-chart-spec"
      ],
      "id": "deck-qa-verification",
      "inputs": [
        {
          "artifactType": "pptx-deck-candidate",
          "fromNodeId": "pptxgenjs-deck-build",
          "name": "deck-candidate",
          "required": true
        },
        {
          "artifactType": "deck-narrative-blueprint",
          "fromNodeId": "narrative-deck-blueprint",
          "name": "deck-blueprint",
          "required": true
        },
        {
          "artifactType": "visual-system-contract",
          "fromNodeId": "visual-system-design",
          "name": "visual-contract",
          "required": true
        },
        {
          "artifactType": "deck-data-model",
          "fromNodeId": "quant-model-chart-spec",
          "name": "deck-data",
          "required": true
        }
      ],
      "knowledgeBaseRefs": [
        "workspace-verification"
      ],
      "objective": "对候选 .pptx 执行 pptx Skill 要求的全量独立 QA（工作目录 /home/nepham/Agent/pi，脚本位于 /home/nepham/Agent/pi/.pi/skills/pptx/scripts），不复用构建者的自述作为结论，并产出可定位缺陷的验收证据。必须实际执行并留存原始输出：(1) 内容 QA：markitdown outputs/delivery/agent-harness-strategy.pptx 逐页比对蓝本，确认十个业务域全部存在且顺序服务决策，并执行占位符 grep（x{3,}|lorem|ipsum|TODO|[insert|This.*(page|slide).*layout）；(2) 文件 QA：python scripts/office/validate.py outputs/delivery/agent-harness-strategy.pptx，逐条记录失败项及其指向的修复；(3) 视觉 QA：python scripts/office/soffice.py --headless --convert-to pdf，删除旧的 slide-*.jpg 后 pdftoppm -jpeg -r 150 出图，逐页（不是抽样）检查并记录：文本溢出/被截断、元素重叠、引用或页脚与正文碰撞、间距 <0.3\" 或失衡、页边距不足 0.5\"、分栏未对齐、低对比文字与图标、模板装饰错位、残留占位、未左对齐正文、装饰色条/下划线条、米色背景；(4) 规则核对：每页至少一个视觉元素、相邻页版式不重复、深浅背景三明治结构（标题/章节/决策结论页深色）、字号落在契约区间、原生图表存在且非位图、备注位于 notes 而非文本框；(5) 数值一致性：抽查上屏关键数字与 outputs/data/deck-data-model.json、roi-output.json 一致，假设类数字在页面上有“假设/目标”标识；(6) 产出 outputs/verification/QA-REPORT.md（逐页结论表：通过/缺陷/严重度/证据位置/要求的源文件修复项，区分产品缺陷、测试缺陷与环境限制，并写明未执行项与原因）与 outputs/verification/evidence/（存放渲染图、markitdown 输出、validate 日志）。不得修改 deck、脚本或任何源 Artifact；不得用“未发现问题”代替覆盖范围说明。",
      "output": {
        "artifactType": "qa-evidence-package",
        "businessPurpose": "以实际渲染与校验证据独立证明 deck 达到可上会质量，并把残留缺陷精确交回构建节点返工",
        "description": "outputs/verification/QA-REPORT.md（逐页缺陷清单、严重度、证据位置、修复要求、覆盖范围与限制）与 outputs/verification/evidence/（slide-*.jpg、markitdown.txt、validate.log、soffice 转换日志、占位符 grep 结果）",
        "id": "deck-qa-evidence"
      },
      "permissions": {
        "externalActions": false,
        "readScopes": [
          ".",
          "outputs/delivery",
          "outputs/content",
          "outputs/data",
          "outputs/design",
          "outputs/research",
          ".pi/skills/pptx"
        ],
        "workspace": "write",
        "writeScopes": [
          "outputs/verification"
        ]
      },
      "requiredCapabilities": [
        "software-verification",
        "test-design",
        "regression-analysis",
        "failure-reproduction"
      ],
      "rework": {
        "targetNodeId": "pptxgenjs-deck-build",
        "maxAttempts": 10
      },
      "routes": {
        "blocked": "staff",
        "exhausted": "user"
      },
      "tools": [
        "read",
        "grep",
        "find",
        "bash",
        "write"
      ],
      "kind": "execution",
      "skills": [
        "pptx"
      ],
      "gate": {
        "aggregation": {
          "conflict": "staff_arbitration",
          "requiredMechanical": "all",
          "requiredSemantic": "all"
        },
        "id": "gate-deck-qa-verification",
        "mechanicalCriteria": [
          {
            "checkId": "artifact-integrity",
            "description": "三重 QA 证据齐备且为实际执行产物",
            "id": "mech-qa-triple-evidence-present",
            "requiredEvidence": [
              "outputs/verification/evidence/markitdown.txt、validate.log 存在且非空，占位符 grep 结果为空命中或已列出命中页",
              "outputs/verification/evidence/ 下 slide-*.jpg 页数 == deck 实际页数（由 QA 日志中 PDF 页数证明）",
              "outputs/verification/QA-REPORT.md 含逐页行且每页引用具体证据文件名"
            ],
            "parameters": {}
          },
          {
            "checkId": "artifact-integrity",
            "description": "文件校验与内容完整性零遗留失败",
            "id": "mech-qa-no-open-defects",
            "requiredEvidence": [
              "validate.log 最终一轮零失败（或失败项均已在 QA-REPORT.md 中标为必须返工）",
              "QA-REPORT.md 中无未关闭的 blocking 缺陷，或已给出明确的返工清单"
            ],
            "parameters": {}
          }
        ],
        "objectiveCoverage": [
          "ac-qa-triple-pass-evidence",
          "ac-executive-decision-outline-coverage",
          "ac-no-boring-or-ai-slop-pages",
          "ac-claim-grounding-and-data-integrity"
        ],
        "reviewers": [
          {
            "capabilities": [
              "artifact-review",
              "evidence-review",
              "risk-identification"
            ],
            "id": "evidence-reviewer",
            "minCount": 1
          },
          {
            "capabilities": [
              "accessibility-review",
              "readability-review",
              "inclusive-design-review"
            ],
            "id": "accessibility-reviewer",
            "minCount": 1
          }
        ],
        "routes": {
          "blocked": "staff",
          "escalate": "staff",
          "pass": "final",
          "rework": "pptxgenjs-deck-build"
        },
        "semanticCriteria": [
          {
            "description": "QA 结论来自实际渲染与校验证据（图片、日志、markitdown）而非构建者自述，覆盖范围与限制说清楚，零缺陷声明有逐页证据支持",
            "evidenceRequirements": [
              "核对至少 5 处缺陷/通过结论引用的证据文件确实存在且内容匹配",
              "确认未执行项均标记为环境限制而非 PASS"
            ],
            "id": "sem-qa-evidence-not-selfreport",
            "required": true,
            "reviewerCapabilities": [
              "evidence-review"
            ]
          },
          {
            "description": "逐页视觉检查确实发现并分类了用户可见缺陷（溢出/重叠/边距/对比度/装饰条/版式重复），且返工要求定位到具体页与具体源文件位置，不改变业务含义",
            "evidenceRequirements": [
              "抽查 QA-REPORT.md 中 3 条缺陷可在对应 slide 图中重现",
              "确认严重度分级理由与修复建议可行"
            ],
            "id": "sem-visual-defect-precision",
            "required": true,
            "reviewerCapabilities": [
              "artifact-review"
            ]
          },
          {
            "description": "面向会议环境的可阅读性与包容性判定：后排可见性、投影对比损失、字号下限、阅读顺序、色弱不单独依赖颜色、备注仅供口述不遮蔽内容",
            "evidenceRequirements": [
              "基于实际渲染图给出低对比或过小文字实例",
              "确认无法在本环境验证的项目已声明限制"
            ],
            "id": "sem-meeting-room-accessibility",
            "required": true,
            "reviewerCapabilities": [
              "accessibility-review"
            ]
          },
          {
            "description": "决策域与数字一致性完整核对：十个业务域均有落地页且论证服务于 go/no-go；上屏数字与冻结数据模型一致、假设已标注；QA 未遗漏商业模式、治理、风险与里程碑等易被略过的域",
            "evidenceRequirements": [
              "输出 QA 对逐域覆盖的结论表",
              "核对 3 个关键 ROI 数字与 roi-output.json 一致"
            ],
            "id": "sem-deliverable-goal-conformance",
            "required": true,
            "reviewerCapabilities": [
              "risk-identification"
            ]
          }
        ]
      }
    }
  ],
  "finalArtifactNodeIds": [
    "pptxgenjs-deck-build",
    "deck-qa-verification"
  ],
  "finalGate": {
    "aggregation": {
      "conflict": "staff_arbitration",
      "requiredMechanical": "all",
      "requiredSemantic": "all"
    },
    "id": "final-gate",
    "mechanicalCriteria": [
      {
        "checkId": "artifact-integrity",
        "description": "最终交付物存在且为单一可上会 .pptx，来路可重建",
        "id": "mech-final-deliverable-intact",
        "requiredEvidence": [
          "outputs/delivery/agent-harness-strategy.pptx 存在且为合法 OOXML，页数与 slide-intent-map.json 一致",
          "scripts/build_deck.js 存在且 BUILD.md 记录的 node 命令可从零重建同一文件",
          "交付回报中包含 .pptx 绝对路径与生成脚本路径"
        ],
        "parameters": {}
      },
      {
        "checkId": "artifact-integrity",
        "description": "Skill 三重 QA 在最终文件上均为零遗留失败",
        "id": "mech-final-qa-clean",
        "requiredEvidence": [
          "最终一轮 validate.log 零失败；markitdown 占位符 grep 零命中",
          "QA-REPORT.md 逐页视觉结论全部通过且引用的 slide-*.jpg 与实际页数一致",
          "无未关闭的 blocking 缺陷项"
        ],
        "parameters": {}
      },
      {
        "checkId": "artifact-integrity",
        "description": "pptxgenjs 与视觉契约硬约束静态扫描通过",
        "id": "mech-final-constraint-scan",
        "requiredEvidence": [
          "脚本中无 # 前缀或 8 位十六进制颜色、无负 shadow offset、无 gradient 填充、无 letterSpacing",
          "原生 addChart 存在且组合图同时声明 valAxes 与 catAxes；堆叠柱标签仅 ctr/inEnd/inBase",
          "pres.layout 在首次 addSlide 前设定；每输出文件一个新 pptxgen 实例"
        ],
        "parameters": {}
      }
    ],
    "objectiveCoverage": [
      "ac-pptx-deliverable-exists",
      "ac-executive-decision-outline-coverage",
      "ac-pptxgenjs-skill-contract-compliance",
      "ac-executive-visual-system-applied",
      "ac-no-boring-or-ai-slop-pages",
      "ac-claim-grounding-and-data-integrity",
      "ac-qa-triple-pass-evidence"
    ],
    "reviewers": [
      {
        "capabilities": [
          "final-acceptance",
          "quality-governance",
          "risk-governance"
        ],
        "id": "staff-quality-governor",
        "minCount": 1
      },
      {
        "capabilities": [
          "artifact-review",
          "evidence-review",
          "specification-conformance",
          "risk-identification"
        ],
        "id": "evidence-reviewer",
        "minCount": 1
      },
      {
        "capabilities": [
          "accessibility-review",
          "readability-review",
          "inclusive-design-review"
        ],
        "id": "accessibility-reviewer",
        "minCount": 1
      }
    ],
    "routes": {
      "blocked": "user",
      "escalate": "staff",
      "pass": "final",
      "rework": "pptxgenjs-deck-build"
    },
    "semanticCriteria": [
      {
        "description": "决策可用性：deck 作为整体能让 CTO/平台/研发/业务四类受众就“12~18 个月内是否建设统一 Agent Harness 平台、投多少、如何分阶段”做出判断，十大业务域完整且无科普化、无空页、无重复结论",
        "evidenceRequirements": [
          "逐域引用页码（来自最终渲染图与 markitdown）",
          "确认决策请求页含 go/no-go、资源、时间点与复核机制，并给出不投入的代价"
        ],
        "id": "sem-final-decision-readiness",
        "required": true,
        "reviewerCapabilities": [
          "quality-governance"
        ]
      },
      {
        "description": "主张与数字诚实性：全部定量主张可回溯到冻结证据包或被明确标为假设/目标；对比矩阵与推荐结论承认所选方案的劣势与开源可用项，无无源宣称",
        "evidenceRequirements": [
          "抽查 5 个关键数字回溯 claim-index.json / roi-output.json",
          "检查不确定性、争议与限定条件在页面上未被丢掉"
        ],
        "id": "sem-final-claim-and-data-integrity",
        "required": true,
        "reviewerCapabilities": [
          "evidence-review"
        ]
      },
      {
        "description": "专业战略观感与无 AI 味：主导色权重明确、深浅三明治结构（标题/章节/决策页深色）、字号层级合规、版式多样且每页有视觉元素；无标题下划线色条、无页宽装饰条、无卡片边饰、无米色默认背景、无纯要点页",
        "evidenceRequirements": [
          "基于最终 slide-*.jpg 逐页确认背景明暗与版式类型",
          "指出任何装饰条或背景默认值残留"
        ],
        "id": "sem-final-visual-system-conformance",
        "required": true,
        "reviewerCapabilities": [
          "artifact-review"
        ]
      },
      {
        "description": "会议环境可读性与包容性：最后一排可读、对比度充足、阅读顺序与结构清晰、图表不仅靠颜色传递含义、备注位于 notes 供口述而不遮挡内容",
        "evidenceRequirements": [
          "引用具体字号/对比度证据页",
          "声明未能在本环境验证的项目及其限制"
        ],
        "id": "sem-final-accessibility-and-legibility",
        "required": true,
        "reviewerCapabilities": [
          "accessibility-review"
        ]
      },
      {
        "description": "交付完整性与可审计性：QA 证据与最终文件对应同一版本，构建命令与修复历史可重现，残留风险与已知限制已向用户如实披露，无未关闭缺陷被静默放行",
        "evidenceRequirements": [
          "核对 QA 证据文件哈希/时间戳与最终 .pptx 对应关系",
          "审阅未解决风险清单与限制说明"
        ],
        "id": "sem-final-delivery-auditability",
        "required": true,
        "reviewerCapabilities": [
          "specification-conformance"
        ]
      },
      {
        "description": "局部通过不等于整体通过：确认从研究→叙事→数据→视觉→构建→QA 的每次局部 Gate 结论在本次最终交付上仍然成立，未出现因返工造成的上游不一致（如叙事修改后数据或视觉未同步）",
        "evidenceRequirements": [
          "比对最后一次返工后各源 Artifact 与 deck 内容一致性",
          "抽查 V-规则编号在 deck 中的落实情况"
        ],
        "id": "sem-final-cross-node-coherence",
        "required": true,
        "reviewerCapabilities": [
          "risk-governance"
        ]
      }
    ]
  }
};
