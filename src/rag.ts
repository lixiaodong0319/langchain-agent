/**
 * 本地知识库检索（RAG）。
 *
 * 流程：加载 docs/ 目录下的 .md/.txt 文档 → 切分成小块 → 用本地 Embedding
 * 模型向量化（transformers.js + ONNX，离线免费）→ 查询时对问题向量做
 * 余弦相似度 top-k，返回最相关片段。工具 retrieve_docs 暴露给 agent，
 * 模型判断问题涉及本地知识时自行调用。
 *
 * 为什么用本地模型而不是供应商的 Embedding API：
 * 当前 API Key 所在的供应商分组没有可用的 embedding 渠道；本地模型
 * 反而离线、免费、自包含，一次下载后不再依赖任何外部服务。
 *
 * 两个注意点：
 * - Embedding 模型首次使用时自动下载（约 100MB，缓存在项目 .cache/ 目录，
 *   之后离线可用）。模型名可用环境变量 AGENT_EMBEDDING_MODEL 更换，
 *   默认 Xenova/bge-small-zh-v1.5（中文效果好）。
 * - 索引惰性构建：第一次调用检索工具时才加载文档并向量化，之后复用同一份
 *   向量；修改 docs/ 需要重启进程生效。
 */
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { pipeline, env } from "@huggingface/transformers";
import { tool } from "langchain";
import * as z from "zod";

// —— ONNX 运行时配置 ——
// transformers.js 在 Node 下默认加载 onnxruntime-node 原生绑定，本机 Node 24
// 加载其 DLL 报 ERR_DLOPEN_FAILED，所以在 package.json 里用 npm overrides 把它
// 换成了 onnxruntime-web（WASM）。WASM 默认是上 CDN 抓取再缓存，Windows 的
// 缓存目录里带冒号会建不出来，所以这里直接指向本地 dist 里的 wasm 文件。
const require = createRequire(import.meta.url);
const ortDist = path.dirname(require.resolve("onnxruntime-web"));
env.useWasmCache = false;
const wasmConfig = env.backends.onnx?.wasm;
if (wasmConfig) {
  wasmConfig.wasmPaths = {
    wasm: pathToFileURL(path.join(ortDist, "ort-wasm-simd-threaded.asyncify.wasm"))
      .href,
    mjs: pathToFileURL(path.join(ortDist, "ort-wasm-simd-threaded.asyncify.mjs"))
      .href,
  };
}
// 模型缓存放项目 .cache/models（已 gitignore），不埋在 node_modules 里，
// npm 重装后模型仍在，不用重新下载。
env.cacheDir = path.resolve(process.cwd(), ".cache/models");

const DOCS_DIR = path.resolve(process.cwd(), "docs");
const EMBED_MODEL =
  process.env.AGENT_EMBEDDING_MODEL?.trim() || "Xenova/bge-small-zh-v1.5";
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;
const TOP_K = 3;

/** 一个文档分块 */
interface Chunk {
  text: string;
  source: string; // 来源文件名，检索结果里带上方便核对
}

/** 特征提取管道：惰性加载，首次调用时触发模型下载 */
let extractorPromise: Promise<any> | null = null;
function getExtractor(): Promise<any> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", EMBED_MODEL);
  }
  return extractorPromise;
}

/** 本地向量化：逐条 embed 文本，mean pooling + 归一化后的向量 */
async function embed(texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor();
  const result: number[][] = [];
  for (const text of texts) {
    const output = await extractor(text, { pooling: "mean", normalize: true });
    result.push(Array.from(output.data as Float32Array));
  }
  return result;
}

/** 已向量化的索引 */
interface Index {
  vectors: number[][];
  chunks: Chunk[];
}

let indexPromise: Promise<Index> | null = null;

/** 缓存索引的 Promise：失败也保留（避免每次调用都重试失败） */
function getIndex(): Promise<Index> {
  if (!indexPromise) indexPromise = buildIndex();
  return indexPromise;
}

async function buildIndex(): Promise<Index> {
  const entries = await readdir(DOCS_DIR, { withFileTypes: true }).catch(() => []);
  const docs = entries.filter((e) => e.isFile() && /\.(md|txt)$/i.test(e.name));
  if (docs.length === 0) {
    throw new Error(`docs/ 目录为空或不存在（${DOCS_DIR}），请先放入知识文档`);
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  const chunks: Chunk[] = [];
  for (const entry of docs) {
    const content = await readFile(path.join(DOCS_DIR, entry.name), "utf8");
    for (const piece of await splitter.splitText(content)) {
      const text = piece.trim();
      if (text) chunks.push({ text, source: entry.name });
    }
  }

  const vectors = await embed(chunks.map((c) => c.text));
  return { vectors, chunks };
}

/** 两个向量的余弦相似度（向量已归一化，等价于点积） */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

async function search(query: string, k = TOP_K): Promise<Chunk[]> {
  const { vectors, chunks } = await getIndex();
  const [queryVector] = await embed([query]);
  return vectors
    .map((v, i) => ({ i, score: cosine(v, queryVector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ i }) => chunks[i]);
}

export const retrieveDocs = tool(
  async ({ query }) => {
    try {
      const hits = await search(query);
      if (hits.length === 0) return "本地文档库中没有找到相关内容。";
      return hits
        .map((h, i) => `[片段 ${i + 1}，来自 ${h.source}]\n${h.text}`)
        .join("\n\n---\n\n");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return (
        `文档检索失败：${reason}。请确认：` +
        `① docs/ 目录下存在 .md/.txt 知识文档；` +
        `② 首次使用能联网下载 Embedding 模型（${EMBED_MODEL}，约 100MB，缓存在 .cache/）。`
      );
    }
  },
  {
    name: "retrieve_docs",
    description:
      "检索本地 docs/ 目录里的知识文档，返回与查询最相关的片段。当问题涉及本地知识库内容（如使用说明、部署、配置）时使用。",
    schema: z.object({
      query: z.string().describe("检索的问题或关键词，例如「如何启动 HTTP 服务」"),
    }),
  },
);