# 会话搜索（Session Search）

Pi 搜索是一个针对已提交会话条目的小型查询接口。共享契约只返回稳定的命中身份；实现可以用后端特定的显示数据扩展命中。

## 核心 API

```ts
export interface SessionSearchHit {
  /** 拥有该条目的会话的逻辑标识符。 */
  readonly sessionId: string;

  /** 该会话内部条目的逻辑标识符。 */
  readonly entryId: string;
}

export interface SessionSearchOptions {
  /** 将结果限制到特定的规范条目类型。 */
  readonly entryTypes?: readonly Entry["type"][];

  /** 返回的最大命中数。后端可能返回更少，不会更多。 */
  readonly limit?: number;

  /** 用于取消的中止信号，例如边输入边搜索。 */
  readonly signal?: AbortSignal;
}

export interface SessionSearch<T extends SessionSearchHit = SessionSearchHit> {
  search(text: string, options?: SessionSearchOptions): AsyncIterable<T>;
}
```

基础命中有意保持最小化：`(sessionId, entryId)` 是跨 JSONL、内存、SQLite FTS 和远程索引的可移植身份。摘要、时间戳、分数、元数据、偏移和排序语义属于具体实现。

## 为什么是异步可迭代

`AsyncIterable` 让消费者可以渲染早期结果、在足够时停止迭代，并用 `AbortSignal` 取消进行中的工作。防抖仍是 UI/调用方的职责；API 只提供取消原语。

```ts
let currentAbortController: AbortController | undefined;

async function updateResults(query: string) {
  currentAbortController?.abort();
  const controller = new AbortController();
  currentAbortController = controller;

  try {
    for await (const hit of search.search(query, { limit: 10, signal: controller.signal })) {
      render(hit);
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  }
}
```

## 默认实现

### 扫描搜索（Scanning search）

可复用的扫描器把会话类可读对象（`getMetadata`、`findEntries` 和 `getLabel`）适配为投影条目：

```ts
export interface SessionSearchCandidate {
  readonly entryId: string;
  readonly seq: number;
  readonly type: Entry["type"];
  readonly timestamp: number;
  readonly text: string;
  readonly fields?: Record<string, unknown>;
}

export interface ScanningSessionSearchHit extends SessionSearchHit {
  readonly timestamp: number;
  readonly snippet: string;
}
```

`SessionSearchCandidate` 是匹配前的扫描器输入：它包含可搜索文本、类型、序列和可选的投影字段。扫描器把匹配的候选变成公共命中。

已打开的会话或存储可以直接扫描：

```ts
const search = createScanningSessionSearch(sessions);

for await (const hit of search.search("authentication", { limit: 10 })) {
  const session = sessionsById.get(hit.sessionId)!;
  const entry = await session.getEntry(hit.entryId);
  console.log(entry);
}
```

JSONL 不需要单独的公共搜索适配器。JSONL 支持的代码可以保持发现/加载本地化，然后把加载的存储传给同一个扫描器：

```ts
async function* jsonlReadables(jsonl: JsonlSessionRepoOptions, query: JsonlSessionListOptions = {}) {
  for (const metadata of await listJsonlSessionMetadata(jsonl, query)) {
    yield loadJsonlSessionStorage(jsonl, metadata);
  }
}

const search = createScanningSessionSearch((query) => jsonlReadables(jsonl, query));
```

如果该操作可能获取写者租约，扫描源不得对 harness 拥有的会话调用 `SessionRepo.open()`。JSONL 应使用只读加载帮助函数；已打开的会话/存储可以直接扫描。

### SQLite FTS

SQLite 搜索暴露扩展命中：

```ts
export interface SqliteSessionSearchHit extends SessionSearchHit {
  readonly metadata: SqliteSessionMetadata;
  readonly timestamp: number;
  readonly score: number;
}
```

```ts
const search = createSqliteSessionSearch({ env, sqlite, databasePath });

for await (const hit of search.search("auth", {
  entryTypes: ["message", "compaction"],
  limit: 20,
})) {
  console.log(hit.sessionId, hit.entryId, hit.score);
}
```

FTS 表和触发器在第一次非空搜索时懒创建。FTS 首次创建时，SQLite 会从规范 `entries` 做一次一次性重建；之后，SQLite 触发器保持 FTS 与规范条目的插入、删除和 payload 更新同步。这让 SQLite 搜索在提交后是新鲜的，但也意味着在该数据库启用搜索时，FTS 触发器失败可能回滚规范的 SQLite 写入。

## 索引后端

搜索索引是后端拥有的派生状态。共享包只导出查询 API；应用或后端包在需要显式索引维护时，可以定义自己的 writer/feed 契约。

### 用 Elasticsearch 的 JSONL 会话

这是应用拥有的胶水代码。核心提供查询契约和 JSONL 会话发现；Elastic writer 契约本地于这个适配器。

```ts
import { Client } from "@elastic/elasticsearch";
import {
  scanningEntries,
  type JsonlSessionMetadata,
  type JsonlSessionRepoOptions,
  type SessionSearch,
  type SessionSearchHit,
  type SessionSearchOptions,
} from "@earendil-works/pi-agent-core";

// JSONL 支持的代码可以从现有的 JSONL 列表/加载帮助函数本地提供这个。
async function* jsonlReadables(jsonl: JsonlSessionRepoOptions, options: { cwd?: string } = {}) {
  for (const metadata of await listJsonlSessionMetadata(jsonl, options)) {
    yield loadJsonlSessionStorage(jsonl, metadata);
  }
}

interface SearchIndexWriter<TItem> {
  apply(items: TItem[]): Promise<void>;
  flush?(): Promise<void>;
}

interface IndexedSessionSearch<T extends SessionSearchHit, TItem>
  extends SessionSearch<T>, SearchIndexWriter<TItem> {}

type ElasticSessionFeedItem =
  | { type: "upsert"; id: string; body: ElasticSessionDoc }
  | { type: "delete"; id: string };

interface ElasticSessionDoc {
  sessionId: string;
  entryId: string;
  seq: number;
  timestamp: number;
  cwd: string;
  text: string;
  metadata: JsonlSessionMetadata;
  fields?: Record<string, unknown>;
}

interface ElasticSessionSearchHit extends SessionSearchHit {
  readonly timestamp: number;
  readonly snippet: string;
  readonly score?: number;
}

class ElasticSessionSearch
  implements IndexedSessionSearch<ElasticSessionSearchHit, ElasticSessionFeedItem>
{
  constructor(
    private readonly client: Client,
    private readonly index: string,
  ) {}

  async apply(items: ElasticSessionFeedItem[]): Promise<void> {
    const operations = items.flatMap((item) => {
      if (item.type === "delete") {
        return [{ delete: { _index: this.index, _id: item.id } }];
      }
      return [{ index: { _index: this.index, _id: item.id } }, item.body];
    });

    if (operations.length > 0) await this.client.bulk({ operations });
  }

  async flush(): Promise<void> {
    await this.client.indices.refresh({ index: this.index });
  }

  async *search(
    text: string,
    options: SessionSearchOptions = {},
  ): AsyncIterable<ElasticSessionSearchHit> {
    const result = await this.client.search<ElasticSessionDoc>({
      index: this.index,
      size: options.limit ?? 20,
      query: {
        bool: {
          must: [{ match: { text } }],
        },
      },
    });

    for (const hit of result.hits.hits) {
      if (!hit._source) continue;
      if (options.signal?.aborted) throw options.signal.reason;
      yield {
        sessionId: hit._source.sessionId,
        entryId: hit._source.entryId,
        timestamp: hit._source.timestamp,
        snippet: hit._source.text,
        score: hit._score ?? undefined,
      };
    }
  }
}
```

追赶/重建作业可以在不获取写者租约的情况下把 JSONL 投影喂给 Elasticsearch：

```ts
async function indexJsonlSessionsIntoElastic(
  jsonl: JsonlSessionRepoOptions,
  elastic: ElasticSessionSearch,
  options: { cwd?: string } = {},
): Promise<void> {
  for await (const session of jsonlReadables(jsonl, { cwd: options.cwd })) {
    const metadata = await session.getMetadata();
    for await (const candidate of scanningEntries(session)) {
      await elastic.apply([{
        type: "upsert",
        id: `${metadata.id}:${candidate.entryId}`,
        body: {
          sessionId: metadata.id,
          entryId: candidate.entryId,
          seq: candidate.seq,
          timestamp: candidate.timestamp,
          cwd: metadata.cwd,
          text: candidate.text,
          metadata,
          fields: candidate.fields,
        },
      }]);
    }
  }

  await elastic.flush();
}
```

## 正确性与失败边界

搜索索引是共享 API 的派生状态：应用可以重试、重建或标记搜索为过期。后端特定选择可以做不同的权衡；SQLite FTS 使用同地触发器，所以 FTS 失败在搜索初始化触发器后可能回滚规范的 SQLite 写入。

如果扫描源产生重复的 `sessionId` 值，应该快速失败，因为基础命中身份是 `(sessionId, entryId)`。索引后端通常在其存储/索引层强制唯一性。

搜索选择加入（opt-in）仍然需要同步/索引层。后续应添加一个默认无操作的搜索索引 sink（例如 `NOOP_SEARCH_INDEX_SINK`），让规范写入点可以无条件发出索引事件，类似于 telemetry 在禁用 telemetry 时使用无操作实现的方式。
