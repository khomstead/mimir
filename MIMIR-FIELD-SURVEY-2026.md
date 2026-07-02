# State of the Art in AI Agent Memory Systems (mid-2026)
## Survey companion to MIMIR-DEEP-DIVE-FINDINGS.md (Q1 evidence — every claim linked)

Research method: web survey (July 2026), primary sources (arXiv, vendor docs, Microsoft Research) plus 2026 comparison literature. The final section maps the field against Mimir's specific design: embedded single-process FalkorDB, Episode/Thought/Entity/Anchor node types, fact-bearing edges with `valid_from`/`valid_until` + episode provenance lists, ADD/UPDATE/INVALIDATE extraction intents, multi-strategy recall, local Qwen3 1024-d embeddings + local gemma extraction, 1–30 users on one Mac.

---

## 1. Agentic memory frameworks

### The landscape

Four systems dominate the 2026 landscape — Mem0, Zep, Letta, Cognee — with a second wave (Hindsight, A-MEM, MemOS, LangMem) contributing architectural ideas. A useful one-line taxonomy from the comparison literature: "Mem0 is a memory layer you bolt onto an existing agent. Letta is a runtime where the agent *is* its memory. Zep builds a temporal knowledge graph from conversation. Cognee builds a knowledge graph from everything else" ([MCP.Directory 2026 comparison](https://mcp.directory/blog/mem0-vs-letta-vs-zep-vs-cognee-2026); [Vectorize's 8-framework roundup](https://vectorize.io/articles/best-ai-agent-memory-systems); [dev.to practical guide](https://dev.to/agdex_ai/ai-agent-memory-in-2026-mem0-vs-zep-vs-letta-vs-cognee-a-practical-guide-cfa)).

**Mem0** ([arXiv 2504.19413](https://arxiv.org/abs/2504.19413), published ECAI 2025) — extraction-centric. An LLM extracts salient facts from each turn and issues **ADD / UPDATE / DELETE / NOOP** operations against a hybrid store (vector + optional graph + KV), with three memory scopes (user, session, agent). The graph variant **Mem0g** adds entity/triplet extraction with semantic node merging and LLM conflict resolution — and notably delivered only **~2% overall gain** over base Mem0 on LoCoMo ([Mem0 paper summary](https://datasciocean.com/en/paper-intro/mem0/); [Mem0 research page](https://mem0.ai/research-3)). Mem0's 2026 token-efficient algorithm reports 91.6 LoCoMo / 93.4 LongMemEval at <7k tokens per query vs 25k+ for full-context ([Mem0 state-of-memory 2026 report](https://mem0.ai/blog/state-of-ai-agent-memory-2026)).

**Zep / Graphiti** ([arXiv 2501.13956](https://arxiv.org/abs/2501.13956); [github.com/getzep/graphiti](https://github.com/getzep/graphiti)) — temporal-knowledge-graph-centric; detailed in §2. Reported 94.8% on DMR (vs MemGPT 93.4%) and up to 18.5% accuracy improvement on LongMemEval with 90% latency reduction (1.6k tokens/response vs 115k full-context), with the biggest wins on temporal reasoning (+38.4%) and multi-session (+30.7%) ([MarkTechPost coverage](https://www.marktechpost.com/2025/02/04/zep-ai-introduces-a-smarter-memory-layer-for-ai-agents-outperforming-the-memgpt-in-the-deep-memory-retrieval-dmr-benchmark/); [Zep paper HTML](https://arxiv.org/html/2501.13956v1)).

**Letta (MemGPT lineage)** ([docs.letta.com/letta-agent/memory](https://docs.letta.com/letta-agent/memory)) — OS-inspired memory hierarchy: the agent self-edits a "core memory" scratchpad in-context and pages to archival storage. Memory is the *runtime*, not a bolt-on. Its distinctive 2025-26 contribution is **sleep-time compute** (§6).

**Cognee** ([cognee.ai](https://www.cognee.ai/blog/deep-dives/grounding-ai-memory)) — Extract–Cognify–Load (ECL) pipeline: 30+ ingestion connectors (PDF, Notion, Slack, audio, images — with OCR/transcription), a "cognify" stage producing a typed, ontology-groundable knowledge graph, and a load stage unifying relational + vector + graph stores. Raised a $7.5M seed; claims >1M pipelines/month across 70+ companies ([funding post](https://www.cognee.ai/blog/cognee-news/cognee-raises-seven-million-five-hundred-thousand-dollars-seed)) but as of mid-2026 lacks SOC 2/HIPAA — flagged as disqualifying for regulated procurement ([MCP.Directory](https://mcp.directory/blog/mem0-vs-letta-vs-zep-vs-cognee-2026)).

**LangMem** ([langchain.com/blog/langmem-sdk-launch](https://www.langchain.com/blog/langmem-sdk-launch)) — LangChain's SDK implementing the semantic/episodic/procedural memory-type taxonomy, with a "Memory Manager" that decides store/update/delete and consolidates over time. Real adoption (~746K monthly PyPI downloads) but still pre-1.0 with slow cadence as of mid-2026 ([Atlan framework comparison](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)).

**Hindsight** ([arXiv 2512.12818](https://arxiv.org/abs/2512.12818); [github.com/vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)) — the closest philosophical cousin to Mimir. Four logical memory networks — **world facts, agent experiences, entity summaries, evolving beliefs** — with exactly three verbs: **retain, recall, reflect** (Tempr does retain/recall; Cara does reflect). Memories are represented as entities + relationships + time series with sparse/dense vectors. Reports 91.4% LongMemEval and 89.6% LoCoMo using an open-source 20B backbone — evidence that a well-structured memory substrate over a small local model beats full-context frontier models ([paper](https://arxiv.org/html/2512.12818v1); [Vectorize launch post](https://vectorize.io/blog/introducing-hindsight-agent-memory-that-works-like-human-memory)).

**A-MEM** ([arXiv 2502.12110](https://arxiv.org/abs/2502.12110), NeurIPS 2025; [github.com/WujiangXu/A-mem](https://github.com/WujiangXu/A-mem)) — Zettelkasten-style atomic notes (content, timestamp, LLM-generated keywords/tags/context, embedding, links). Key mechanism: **memory evolution** — inserting a new note can trigger the LLM to update the contextual descriptions of existing linked notes, so the network reorganizes itself rather than only accreting.

**MemOS** ([overview](https://llmmultiagents.com/en/blogs/memos-revolutionizing-llm-memory-management-as-a-first-class-operating-system)) — treats memory as an OS-level resource via **MemCube**, a standardized container enabling clone/merge/branch of memory units across storage backends. More architectural manifesto than adopted product, but its portability framing is influential.

### Benchmarks (the field's scoreboard)

- **LoCoMo** (1,540 questions: single-hop, multi-hop, temporal, open-domain) and **LongMemEval** (500 questions incl. knowledge updates and multi-session recall) are the canonical pair; **BEAM** extends to 1M–10M token scales ([Mem0 benchmark explainer](https://mem0.ai/blog/ai-memory-benchmarks-in-2026)).
- Mid-2026 SOTA is roughly **92.5 LoCoMo / 94.4 LongMemEval at ~6,900 tokens/query**; biggest recent algorithmic gains are on temporal (+29.6) and multi-hop (+23.1) reasoning ([Mem0 2026 report](https://mem0.ai/blog/state-of-ai-agent-memory-2026)). ByteRover 2.0 claims 92.2% LoCoMo ([ByteRover benchmark post](https://www.byterover.dev/blog/benchmark-ai-agent-memory)).
- **LongMemEval-V2** (2026) pushes evaluation toward "experienced colleague" behavior — abstention, cross-session synthesis — because V1 saturated ([arXiv 2605.12493](https://arxiv.org/html/2605.12493v1)). Newer incremental-interaction benchmarks argue static QA over transcripts under-tests real memory ([arXiv 2507.05257](https://arxiv.org/html/2507.05257v3)).
- Caveat the field acknowledges: LoCoMo/LongMemEval measure *conversational recall*, not longitudinal synthesis, proactivity, or multimodal evidence. No public benchmark covers Mimir's roles (b) or (a) well.

---

## 2. Temporal knowledge graphs for agent memory

**Graphiti's bi-temporal model is the reference design.** Every edge carries four timestamps: `valid_at`/`invalid_at` (when the fact was true *in the world*) and `created_at`/`expired_at` (when the system learned/retracted it) ([Zep temporal KG explainer](https://www.getzep.com/ai-agents/temporal-knowledge-graph/); [Neo4j deep-dive on Graphiti](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/); [arXiv 2501.13956](https://arxiv.org/html/2501.13956v1)). On ingest, Graphiti runs hybrid search (semantic + BM25 + graph) to find conflicting edges and **invalidates rather than deletes** — outdated facts get `invalid_at` stamped, preserving history and enabling as-of-date queries without recomputation ([Graphiti GitHub](https://github.com/getzep/graphiti)). This valid-time/transaction-time distinction is what powers Zep's outsized temporal-reasoning gains (+38.4%).

**Event-sourced memory** is the 2026 emerging pattern beyond bi-temporality:
- **"The Log is the Agent"** (ActiveGraph, [arXiv 2605.21997](https://arxiv.org/abs/2605.21997), Apache-2.0 at github.com/yoheinakajima/activegraph): the append-only event log is the sole source of truth; the working graph is a **deterministic projection** of the log. Deterministic replay, cheap forking at any event, end-to-end lineage.
- **ESAA-Conversational** ([arXiv 2606.23752](https://arxiv.org/abs/2606.23752)): conversation captured mechanically into an append-only `activity.jsonl`; read models projected deterministically.
- **DyG-RAG** ([arXiv 2507.13396](https://arxiv.org/pdf/2507.13396)) does event-centric dynamic-graph retrieval; **ES-Mem** ([arXiv 2601.07582](https://arxiv.org/pdf/2601.07582)) segments dialogue memory by event boundaries.

The synthesis position the field has converged on: **raw immutable events at the bottom, derived/invalidatable knowledge above, temporal validity on the derived layer.**

---

## 3. GraphRAG variants and when graph beats vector

**Microsoft GraphRAG** ([microsoft/graphrag](https://github.com/microsoft/graphrag/discussions/1490)) — full-corpus entity/relationship extraction plus hierarchical **community summaries** (Leiden clustering), enabling "global" corpus-level questions vector RAG can't answer. Expensive to index. Enterprise-benchmark claims of 86% vs 32% baseline accuracy circulate in the comparison literature ([Medium: GraphRAG vs HippoRAG vs PathRAG](https://medium.com/graph-praxis/graphrag-vs-hipporag-vs-pathrag-vs-og-rag-choosing-the-right-architecture-for-your-knowledge-graph-a4745e8b125f)).

**LazyGraphRAG** ([Microsoft Research blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)) — the important correction: defer all LLM summarization to *query time*, index with cheap NLP (noun-phrase graph). Indexing at ~0.1% of GraphRAG's cost; in Microsoft's BenchmarkQED evaluation it won **all 96 comparisons** against GraphRAG local/global/DRIFT, vector RAG at 8k and 120k windows, LightRAG, RAPTOR, and TREX ([BenchmarkQED post](https://www.microsoft.com/en-us/research/blog/benchmarkqed-automated-benchmarking-of-rag-systems/)). Lesson: **eager exhaustive extraction is not where the value is; query-time reasoning over a light graph often wins.**

**HippoRAG 2** ([comparison analysis](https://medium.com/graph-praxis/graphrag-vs-hipporag-vs-pathrag-vs-og-rag-choosing-the-right-architecture-for-your-knowledge-graph-a4745e8b125f)) — hippocampus-inspired: open-information-extraction KG + **Personalized PageRank** spreading activation from query-matched seed nodes. ~10x cheaper than GraphRAG for multi-hop; leads Context Relevance (85.8–87.8%). **LightRAG** ([Analytics Vidhya overview](https://www.analyticsvidhya.com/blog/2025/01/lightrag/)) offers dual-level retrieval with incremental index updates — but lost head-to-head to LazyGraphRAG.

**The when-does-graph-help evidence** — GraphRAG-Bench / "When to use Graphs in RAG" (ICLR 2026, [arXiv 2506.05690](https://arxiv.org/abs/2506.05690); [repo](https://github.com/GraphRAG-Bench/GraphRAG-Benchmark)): GraphRAG **often fails to beat vanilla RAG**; graphs help measurably only when the answer depends on **relationships among entities/documents/events** (multi-hop, cross-document synthesis, temporal chains), and graph context can actively hurt via prompt inflation/noise on simple factual tasks. The field's most important negative result: graph structure is a targeted tool, not a universal upgrade.

---

## 4. Longitudinal / trajectory tracking of a person

The weakest area of the commercial memory field and the strongest area of a separate academic tradition (AIED/EDM) that the memory startups largely ignore.

**Mastery models.** Bayesian Knowledge Tracing is an HMM over binary skill mastery; the standard variant is monotonic, but **BKT-with-forgetting adds P(F), the learned→unlearned transition — the canonical way to represent non-monotonic mastery** ([BKT overview](https://www.emergentmind.com/topics/bayesian-knowledge-tracing-bkt); [pyBKT paper — supports forgetting variants](https://www.mdpi.com/2624-8611/5/3/50)). Deep Knowledge Tracing successors (DKT2, [arXiv 2501.14256](https://arxiv.org/pdf/2501.14256); families surveyed in [ACM 2025 review](https://dl.acm.org/doi/10.1145/3729605.3729620)) model non-monotonic trajectories natively. 2025-26 work targets **concept drift over long horizons** ([arXiv 2511.00704](https://arxiv.org/html/2511.00704v1)) and LLM-based KT ([Next Token Knowledge Tracing, arXiv 2511.02599](https://arxiv.org/pdf/2511.02599); [systematic review, arXiv 2412.09248](https://arxiv.org/pdf/2412.09248)). Critical caveat: **all of this assumes discrete correct/incorrect item responses** — none ingests narrative anecdotes.

**Open Learner Models.** Bull & Kay's **SMILI:()** framework (IJAIED 2016) is the canonical treatment of making the system's beliefs about a learner **inspectable, contestable, and in some designs negotiable** by the learner ([SMILI framework](https://www.researchgate.net/publication/262317857_Student_Models_that_Invite_the_Learner_In_The_SMILI_Open_Learner_Modelling_Framework); [Open Learner Models chapter](https://link.springer.com/chapter/10.1007/978-3-642-14363-2_15)). OLMs foster metacognition and require trust/credibility in visualization ([OLMs as drivers for metacognitive processes](https://link.springer.com/chapter/10.1007/978-1-4419-5546-3_23)). Maps directly to Constitution principles 1/3/5.

**Narrative + photographic evidence in deployed practice.** The one place multi-year, non-monotonic growth from anecdotes + photographed artifacts is *routine* is early-childhood observational assessment: **Teaching Strategies GOLD** — notes, photos, videos, work samples mapped to color-coded developmental progressions birth–grade 3, with published construct validation ([product](https://teachingstrategies.com/product/gold/); [validation study](https://www.sciencedirect.com/science/article/abs/pii/S0885200621000120)). The evidence→progression mapping is human, not AI. AI-assisted portfolio assessment is emerging in higher ed ([Pedagogies journal study, 2025](https://www.tandfonline.com/doi/full/10.1080/1554480X.2025.2545212); [Anthology whitepaper](https://backstage.anthology.com/sites/default/files/2025-10/Future_Assessment_AI_WhitePaper.pdf)). Mainstream AI-tutor products (Khanmigo, SchoolAI) offer *recent-work summaries and real-time dashboards*, not multi-year trajectory models ([Khanmigo teacher tools](https://support.khanacademy.org/hc/en-us/articles/14799047733645-What-teacher-tools-are-available-on-Khanmigo); [SchoolAI dashboard](https://schoolai.com/blog/how-to-use-schoolai-teacher-dashboard-understand-student-needs-real-time)).

**The gap:** psychometric KT (rigorous, item-response-only) and narrative portfolio assessment (rich evidence, human-judged) have not been unified by any named system. An LLM-extracted, provenance-linked competency graph over narrative episodes — with temporal validity so regression is representable — is exactly the missing artifact.

---

## 5. Multimodal memory ingestion

**Research systems (2025-26):** the area just got its benchmarks — **Mem-Gallery** (1,711 QA pairs over 240 multimodal dialogues), **SMMBench** ([arXiv 2605.15710](https://arxiv.org/pdf/2605.15710)), **H2HMem** ([arXiv 2606.09461](https://arxiv.org/pdf/2606.09461)), **OmniMem/Omni-SimpleMem** ([arXiv 2604.01007](https://arxiv.org/html/2604.01007v1)). MemVerse builds a hierarchical episodic-semantic multimodal KG; MemCtrl trains a gate deciding which visual observations to retain/update/discard ([survey context](https://mem0.ai/blog/state-of-ai-agent-memory-2026)). Verdict: active but immature — benchmarks arrived before robust systems.

**Products:** **Limitless** (ex-Rewind; $33M+ from a16z/Altman) is the deployed proof-point for voice-as-first-class-memory: all-day capture, speaker diarization, playback of source audio beneath derived transcripts/summaries ([limitless.ai](https://www.limitless.ai/); [hands-on review](https://thoughts.jock.pl/p/voice-ai-hardware-limitless-pendant-real-world-review-automation-experiments)). Among frameworks, **Cognee** is furthest on ingestion breadth (audio transcription + image OCR) ([Cognee guide](https://cohorte.co/blog/cognee-building-ai-agent-memory-in-five-lines-of-code--a-friendly-no-hype-field-guide)); Mem0 supports multimodal inputs but flattens to text facts.

**Design consensus:** keep the original artifact addressable; derive text (transcript, caption, VLM description) as the searchable layer; link derived memory back to the artifact for provenance. Nobody has a polished "photographed student artifact → competency evidence with provenance" pipeline.

---

## 6. Proactive retrieval / connection-surfacing

Three distinct mechanisms have emerged:

**1. Offline consolidation ("sleep").** Letta's **sleep-time compute** ([paper + repo](https://github.com/letta-ai/sleep-time-compute); [blog](https://www.letta.com/blog/sleep-time-compute/); [docs](https://docs.letta.com/guides/agents/architectures/sleeptime/)): a background agent shares the primary agent's memory and repeatedly calls `rethink_memory()` during idle time — reorganizing, forming connections, pre-computing inferences; cuts test-time compute up to ~5x. Academic versions: "Anticipate and Learn" ([arXiv 2605.25971](https://arxiv.org/pdf/2605.25971)), CogniFold ([arXiv 2605.13438](https://arxiv.org/pdf/2605.13438)).

**2. Scheduled proactive delivery.** **ChatGPT Pulse** (OpenAI, Sept 2025): overnight asynchronous research over chat history, memory, opt-in Gmail/Calendar, delivered as morning briefing cards ([announcement](https://openai.com/index/introducing-chatgpt-pulse/); [help center](https://help.openai.com/en/articles/12293630-chatgpt-pulse)). Notable: memory must be enabled, connectors opt-in, user-curatable topics.

**3. Memory coupled to proactive triggers.** **ProAct** couples memory updates directly to proactive behavior ([Memory in the Age of AI Agents survey, arXiv 2512.13564](https://arxiv.org/pdf/2512.13564)); LLAMAPIE does proactive in-ear whispered assistance ([arXiv 2505.04066](https://arxiv.org/pdf/2505.04066)); A-MEM's link-generation is unprompted connection-surfacing at write time ([arXiv 2502.12110](https://arxiv.org/abs/2502.12110)).

**What's unsolved:** *non-obvious* connection quality. Pulse surfaces "relevant to your calendar tomorrow"; nobody has a validated mechanism for "these two things you never mentioned together are structurally related" with an acceptable precision/annoyance ratio. No benchmark for proactive surfacing exists; interruption-cost calibration is open.

---

## What the field says about Mimir

### What Mimir got right (independently converged with SOTA)

1. **Episode = immutable ground truth with derived layers** — exactly Zep's episode subgraph, Hindsight's experiences-vs-beliefs split, the event-sourcing papers' log-as-truth ([arXiv 2605.21997](https://arxiv.org/abs/2605.21997)). "Never truncate the Episode; hydrate back to it" is the field's consensus invariant.
2. **Soft invalidation over deletion** — Graphiti and Mem0 both validate the `[INVALIDATED]` prefix + ADD/UPDATE/INVALIDATE pipeline. Mimir's cross-tenant downgrade-only INVALIDATE is *stricter* than anything shipped commercially.
3. **Fact-bearing edges with temporal windows + provenance lists** — precisely Graphiti's core innovation ([Neo4j write-up](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)); Zep's temporal-reasoning wins are the evidence it pays off.
4. **Multi-strategy recall** — parallels Graphiti's semantic + BM25 + graph hybrid; GraphRAG-Bench vindicates parallel strategies over graph-only ([arXiv 2506.05690](https://arxiv.org/abs/2506.05690)).
5. **Small local models can win** — Hindsight beating full-context GPT-4o on LongMemEval with an open 20B backbone ([arXiv 2512.12818](https://arxiv.org/abs/2512.12818)). At 1–30 users, embedded FalkorDB on one Mac is defensible.
6. **The Anchor node type is genuinely novel** — nothing surveyed has a first-class tension-checked constraint layer. For role (c), an explicit constraint layer with provenance is what the 2026 regulatory climate demands — GUARD Act cleared Senate Judiciary 22-0 ([TrustArc 2026 children's-AI guide](https://trustarc.com/resource/ai-childrens-data-2026/); [COPPA amendments enforceable April 2026](https://statvix.com/coppa-and-ferpa-in-2026-protecting-student-data-in-the-age-of-ai/)). Mimir's fail-closed tenant contracts are ahead of commercial memory vendors (Cognee lacks even SOC 2).

### What Mimir is missing (per role)

**(a) EA — proactive surfacing.** Recall is query-driven; the field moved to write-time link generation (A-MEM), idle-time consolidation (Letta sleep-time), scheduled delivery (Pulse). No background job re-reads the graph and forms new edges; no daily-digest surface; always-on anchor injection (LIMIT 12) is a static version of what should be consolidation-driven. No community/global layer for "themes across the quarter" (LazyGraphRAG's cheap query-time variant is the model).

**(b) Faculty↔student growth.** Temporal edges can *store* non-monotonic evidence but there is no **learner-model layer**: no per-competency state, no forgetting/regression semantics (BKT-F's P(F), [pyBKT](https://www.mdpi.com/2624-8611/5/3/50)), no evidence-strength notion, no **Open Learner Model** surface ([SMILI](https://www.researchgate.net/publication/262317857_Student_Models_that_Invite_the_Learner_In_The_SMILI_Open_Learner_Modelling_Framework)). The plumbing (fact edges + provenance) is the right substrate; the missing piece is a Competency node whose summary is a *trajectory*, not a merged blob — **LLM UPDATE-merge destroys exactly the non-monotonic shape role (b) needs.** Teaching Strategies GOLD ([product](https://teachingstrategies.com/product/gold/)) is the deployed workflow to emulate. Also: **no image ingestion** — Episode is text-only today.

**(c) Minor-safe thought partner.** Tenant isolation is strong; the field would flag: entity dedup at org scale (Graphiti MinHash/LSH remains the cited fix); no data-minimization/retention policy layer (2026 COPPA emphasizes minimization — TTLs and purpose-scoping, not just isolation, [SchoolAI compliance guide](https://schoolai.com/blog/ensuring-ferpa-coppa-compliance-school-ai-infrastructure)); California AB 1159's direction — student data barred from training models ([ArentFox Schiff analysis](https://www.afslaw.com/perspectives/ai-law-blog/the-development-ai-and-protecting-student-data-privacy)) — makes Mimir's all-local posture a *selling point* no cloud vendor matches.

**Cross-cutting technical debts the field has named:** single-timestamp edges, not fully bi-temporal (no transaction-time pair — Graphiti's four-timestamp model enables "what did we believe on date X" audits, valuable for OLM contestability and consent audits, [Zep temporal KG](https://www.getzep.com/ai-agents/temporal-knowledge-graph/)); no edge embeddings / naive dedup (already known); `hydrateNode` LIMIT 1 (high-stakes answers need the full provenance list); contradiction detection only for Anchors — extending the tension check to fact edges is the single highest-leverage remaining port.

### What nobody has solved (Mimir is not behind here)

1. **Narrative-evidence learner modeling** — KT requires item responses; the memory field doesn't model competence. Role (b) is genuine white space.
2. **Non-obvious connection surfacing with calibrated interruption** — no validated "surprising but true," no benchmark.
3. **Proactivity evaluation generally** — LongMemEval-V2 ([arXiv 2605.12493](https://arxiv.org/html/2605.12493v1)) only begins to test synthesis/abstention.
4. **Multimodal provenance-grade memory** — benchmarks predate credible systems.
5. **Regulatory-grade memory for minors** — consent-gated, minimized, auditable long-term AI memory of a child is unbuilt territory across the industry.

**Bottom line:** Mimir's substrate matches or anticipates the 2026 consensus — Graphiti and Hindsight are its closest published peers and validate nearly every core choice. Its gaps are all in the *layers above the substrate*: a sleep-time consolidation loop (a), a trajectory-preserving Competency/OLM layer with image evidence (b), bi-temporal audit + retention policy (c). Its Anchor mechanism and all-local privacy posture are differentiators the field hasn't matched.
