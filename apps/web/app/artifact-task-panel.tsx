"use client";

import {
  ARTIFACT_CHUNK_SIZE_BYTES,
  ARTIFACT_MAX_SIZE_BYTES,
  ARTIFACT_SUPPORTED_MEDIA_TYPES,
  type ArtifactChunkDescriptor,
  type ArtifactSupportedMediaType,
  type CreateArtifactTaskResponse,
  type CreateArtifactUploadResponse,
  type MarketplaceApiErrorBody,
  type MarketplaceDashboardSnapshot,
  type MarketplacePrivacyMode,
  type PurgeableMarketplaceResource
} from "@token-streaming/protocol";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";

interface ArtifactTaskPanelProps {
  snapshot: MarketplaceDashboardSnapshot;
  onSnapshot: (snapshot: MarketplaceDashboardSnapshot) => void;
  onNotice: (message: string) => void;
  onPurge: (resourceType: PurgeableMarketplaceResource, resourceId: string) => Promise<void>;
}

type UploadState = {
  phase: "idle" | "hashing" | "uploading" | "queuing";
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
  partNumber: number;
  chunkCount: number;
};

type BrowserResumeState = {
  version: 3;
  artifactId: string;
  fileName: string | null;
  sizeBytes: number;
  lastModified: number;
  mediaType: ArtifactSupportedMediaType;
  privacyMode: MarketplacePrivacyMode;
  parts: ArtifactChunkDescriptor[];
};

const RESUME_STORAGE_KEY = "gongsuanyun.artifact-upload.v3";
const LEGACY_RESUME_STORAGE_KEYS = ["gongsuanyun.artifact-upload.v2"] as const;

const EMPTY_UPLOAD: UploadState = {
  phase: "idle",
  fileName: "",
  uploadedBytes: 0,
  totalBytes: 0,
  partNumber: 0,
  chunkCount: 0
};

export function ArtifactTaskPanel({ snapshot, onSnapshot, onNotice, onPurge }: ArtifactTaskPanelProps) {
  const [upload, setUpload] = useState<UploadState>(EMPTY_UPLOAD);
  const refreshInFlight = useRef(false);
  const models = [...new Set(snapshot.marketOffers.filter((offer) => !offer.mine).map((offer) => offer.model))];
  const active = snapshot.artifactTasks.some((task) => ["queued", "claimed", "running"].includes(task.status));

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(async () => {
      if (refreshInFlight.current) return;
      refreshInFlight.current = true;
      try {
        onSnapshot(await readDashboard());
      } catch {
        // The manual refresh remains available; transient polling errors do not
        // interrupt a task that is already executing on the supplier Agent.
      } finally {
        refreshInFlight.current = false;
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [active, onSnapshot]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (upload.phase !== "idle") return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const file = form.get("artifact");
    if (!(file instanceof File) || file.size < 1) {
      onNotice("请选择一个非空文件");
      return;
    }
    if (file.size > ARTIFACT_MAX_SIZE_BYTES) {
      onNotice("文件超过 256 MiB 上限");
      return;
    }
    const mediaType = resolveMediaType(file);
    if (!mediaType) {
      onNotice("当前只支持 UTF-8 文本、Markdown、CSV、JSON、NDJSON 与 XML");
      return;
    }
    const privacyMode = String(form.get("privacyMode")) as MarketplacePrivacyMode;
    if (privacyMode !== "standard" && privacyMode !== "strict") {
      onNotice("隐私留存模式无效");
      return;
    }
    const chunkCount = Math.ceil(file.size / ARTIFACT_CHUNK_SIZE_BYTES);
    setUpload({ phase: "hashing", fileName: file.name, uploadedBytes: 0, totalBytes: file.size, partNumber: 0, chunkCount });
    try {
      let resume = readResumeState(file, mediaType, privacyMode);
      if (!resume) {
        const created = await requestJson<CreateArtifactUploadResponse>("/api/v1/artifacts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fileName: privacyMode === "strict" ? null : file.name,
            mediaType,
            sizeBytes: file.size,
            privacyMode
          })
        });
        resume = {
          version: 3,
          artifactId: created.artifact.artifactId,
          fileName: privacyMode === "strict" ? null : file.name,
          sizeBytes: file.size,
          lastModified: file.lastModified,
          mediaType,
          privacyMode,
          parts: []
        };
        writeResumeState(resume);
      } else {
        onNotice(`已恢复 ${resume.parts.length}/${chunkCount} 个完成分块，正在重新校验本地文件`);
      }
      const parts: ArtifactChunkDescriptor[] = [...resume.parts];
      for (let index = 0; index < chunkCount; index += 1) {
        const partNumber = index + 1;
        const start = index * ARTIFACT_CHUNK_SIZE_BYTES;
        const end = Math.min(file.size, start + ARTIFACT_CHUNK_SIZE_BYTES);
        const chunk = file.slice(start, end);
        setUpload((state) => ({ ...state, phase: "hashing", partNumber }));
        const sha256 = await digestBlob(chunk);
        const completed = parts.find((part) => part.partNumber === partNumber);
        if (completed) {
          if (completed.sizeBytes !== chunk.size || completed.sha256 !== sha256) {
            clearResumeState();
            throw new Error("本地文件内容与断点记录不一致，已清除旧记录，请重新提交");
          }
          setUpload((state) => ({ ...state, uploadedBytes: end }));
          continue;
        }
        setUpload((state) => ({ ...state, phase: "uploading", partNumber }));
        await uploadChunk(resume.artifactId, partNumber, chunk, sha256);
        parts.push({ partNumber, sizeBytes: chunk.size, sha256 });
        parts.sort((left, right) => left.partNumber - right.partNumber);
        resume.parts = [...parts];
        writeResumeState(resume);
        setUpload((state) => ({ ...state, uploadedBytes: end }));
      }
      await requestJson(`/api/v1/artifacts/${encodeURIComponent(resume.artifactId)}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts })
      });
      setUpload((state) => ({ ...state, phase: "queuing" }));
      const task = await requestJson<CreateArtifactTaskResponse>("/api/v1/artifact-tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `artifact-task-${crypto.randomUUID()}`
        },
        body: JSON.stringify({
          artifactId: resume.artifactId,
          model: String(form.get("model")),
          instruction: String(form.get("instruction")),
          dataClass: String(form.get("dataClass")),
          maxOutputTokens: Number(form.get("maxOutputTokens")),
          maxTotalTokens: Number(form.get("maxTotalTokens")),
          supplierProcessingAcknowledged: form.get("supplierProcessingAcknowledged") === "on"
        })
      });
      clearResumeState();
      onSnapshot(await readDashboard());
      formElement.reset();
      onNotice(`文件任务已进入队列 · ${task.task.taskId.slice(0, 24)} · 完成凭证验证后才扣费`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "文件任务提交失败");
    } finally {
      setUpload(EMPTY_UPLOAD);
    }
  }

  const percent = upload.totalBytes > 0 ? Math.round(upload.uploadedBytes / upload.totalBytes * 100) : 0;
  return <>
    <section className="panel artifact-submit-panel">
      <div className="panel-heading"><div><span className="section-kicker">RESUMABLE ARTIFACT JOB</span><h3>提交大文件异步任务</h3></div><span className="health-pill">最大 256 MiB</span></div>
      <p className="artifact-intro">浏览器按 4 MiB 分块计算 SHA-256 后上传；平台分块加密保存，供应 Agent 主动领取、分段处理并持续回报检查点。</p>
      <form className="inference-form artifact-form" onSubmit={submit}>
        <label>文件<input name="artifact" type="file" required accept=".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.ndjson,.xml,text/plain,text/markdown,text/csv,text/tab-separated-values,application/json,application/x-ndjson,application/xml,text/xml" /></label>
        <div className="form-grid"><label>精确模型<select name="model" disabled={models.length === 0}>{models.length ? models.map((model) => <option key={model}>{model}</option>) : <option>暂无支持文件任务的在线供给</option>}</select></label><label>数据等级<select name="dataClass" defaultValue="P0"><option value="P0">P0 · 公开数据</option><option value="P1">P1 · 一般业务数据</option></select></label></div>
        <label>隐私留存<select name="privacyMode" defaultValue="strict"><option value="strict">严格 · 隐藏原文件名，任务结束清除输入</option><option value="standard">标准 · 输入最多保留 48 小时</option></select></label>
        <label>处理要求<textarea name="instruction" required maxLength={8000} defaultValue="阅读全部文件，提取关键事实，标出不确定项，并给出结构化中文总结。" /></label>
        <div className="form-grid"><label>最终输出 token 上限<input name="maxOutputTokens" type="number" min="1" max="32768" defaultValue="4096" required /></label><label>全任务 token 预算<input name="maxTotalTokens" type="number" min="4096" max="10000000" defaultValue="200000" required /></label></div>
        {upload.phase !== "idle" && <div className="artifact-upload-progress" role="status" aria-live="polite"><div><b>{phaseLabel(upload.phase)}</b><span>{upload.fileName} · 分块 {upload.partNumber}/{upload.chunkCount}</span></div><progress max="100" value={percent} /><small>{formatBytes(upload.uploadedBytes)} / {formatBytes(upload.totalBytes)} · {percent}%</small></div>}
        <div className="policy-note privacy-warning"><span>!</span><p><b>执行方仍会读取文件明文</b><small>加密保护传输和静态存储，但供应 Agent 与上游 Provider 在处理时可见正文；请勿上传 P2/P3、密钥、密码或无权共享的数据。</small></p></div>
        <label className="consent-check"><input name="supplierProcessingAcknowledged" type="checkbox" required />我已理解文件会发送给匹配供应节点和上游 Provider 执行</label>
        <div className="policy-note"><span>◇</span><p><b>文件不是代码</b><small>供应端不解压、不执行、不访问文件中的 URL；仅支持声明的 UTF-8 文本类型，摘要、模型、用量或签名不一致则不结算</small></p></div>
        <button className="primary-button full" disabled={upload.phase !== "idle" || models.length === 0}>{upload.phase === "idle" ? "加密上传并排队" : phaseLabel(upload.phase)}</button>
      </form>
    </section>
    <ArtifactTaskTable snapshot={snapshot} onPurge={onPurge} />
  </>;
}

function ArtifactTaskTable({ snapshot, onPurge }: {
  snapshot: MarketplaceDashboardSnapshot;
  onPurge: (resourceType: PurgeableMarketplaceResource, resourceId: string) => Promise<void>;
}) {
  return <article className="panel table-panel artifact-task-table"><div className="panel-heading"><div><span className="section-kicker">ASYNC TASKS</span><h3>文件任务与执行凭证</h3></div><span className="health-pill">{snapshot.artifactTasks.length} 个任务</span></div><div className="table-scroll"><table><thead><tr><th>文件 / 模型</th><th>状态</th><th>进度</th><th>用量 / 实扣</th><th>结果或错误</th><th>隐私</th></tr></thead><tbody>{snapshot.artifactTasks.map((task) => <tr key={task.taskId}><td><b>{task.fileName}</b><small className="cell-sub">{task.model} · {formatDate(task.createdAt)}</small></td><td><span className={`status-pill ${task.status === "completed" ? "live" : task.status === "failed" || task.status === "cancelled" ? "danger" : "review"}`}>{taskStatusLabel(task.status)}</span><small className="cell-sub">第 {task.progress.attempt} 次执行</small></td><td><b>{progressPercent(task)}%</b><small className="cell-sub">{task.progress.completedSegments}/{task.progress.totalSegments ?? "—"} 段 · {formatBytes(task.progress.processedBytes)}</small></td><td>{task.totalTokens === null ? "—" : `${task.totalTokens.toLocaleString()} tokens`}<small className="cell-sub">{task.chargeMicros === null ? "完成后结算" : formatMicros(task.chargeMicros)}</small></td><td>{task.output ? <details><summary>查看结果</summary><pre>{task.output}</pre>{task.evidenceDigest && <code title={task.evidenceDigest}>{shortDigest(task.evidenceDigest)}</code>}</details> : <span>{task.contentPurgedAt ? "内容已清除" : task.errorCode ?? (task.status === "queued" ? "等待已授权 Agent" : "处理中…")}</span>}</td><td><span className="scope-pill">{task.privacyMode === "strict" ? "严格" : "标准"}</span>{task.contentPurgedAt ? <small className="cell-sub">已清除</small> : <button className="table-action danger" onClick={() => void onPurge("artifact-task", task.taskId)}>清除内容</button>}</td></tr>)}{snapshot.artifactTasks.length === 0 && <tr><td colSpan={6}><div className="empty-row">尚未提交文件任务</div></td></tr>}</tbody></table></div></article>;
}

async function uploadChunk(artifactId: string, partNumber: number, chunk: Blob, sha256: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await requestJson(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/chunks/${partNumber}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "x-content-sha256": sha256 },
        body: chunk
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await wait(250 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

async function requestJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const value = await response.json() as T | MarketplaceApiErrorBody;
  if (!response.ok) throw new Error(readApiError(value));
  return value as T;
}

async function readDashboard(): Promise<MarketplaceDashboardSnapshot> {
  return requestJson<MarketplaceDashboardSnapshot>("/api/v1/dashboard");
}

async function digestBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function resolveMediaType(file: File): ArtifactSupportedMediaType | null {
  const declared = file.type.split(";", 1)[0]?.trim().toLowerCase();
  if ((ARTIFACT_SUPPORTED_MEDIA_TYPES as readonly string[]).includes(declared)) return declared as ArtifactSupportedMediaType;
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return ({
    txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv",
    tsv: "text/tab-separated-values", json: "application/json", jsonl: "application/x-ndjson",
    ndjson: "application/x-ndjson", xml: "application/xml"
  } as Record<string, ArtifactSupportedMediaType>)[extension] ?? null;
}

function readResumeState(
  file: File,
  mediaType: ArtifactSupportedMediaType,
  privacyMode: MarketplacePrivacyMode
): BrowserResumeState | null {
  try {
    for (const key of LEGACY_RESUME_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    }
    const raw = resumeStorage(privacyMode).getItem(RESUME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BrowserResumeState;
    if (
      parsed.version !== 3 || typeof parsed.artifactId !== "string" || !Array.isArray(parsed.parts) ||
      parsed.fileName !== (privacyMode === "strict" ? null : file.name) || parsed.sizeBytes !== file.size ||
      parsed.lastModified !== file.lastModified || parsed.mediaType !== mediaType || parsed.privacyMode !== privacyMode
    ) return null;
    return parsed;
  } catch {
    clearResumeState();
    return null;
  }
}

function writeResumeState(value: BrowserResumeState): void {
  resumeStorage(value.privacyMode).setItem(RESUME_STORAGE_KEY, JSON.stringify(value));
}

function clearResumeState(): void {
  window.localStorage.removeItem(RESUME_STORAGE_KEY);
  window.sessionStorage.removeItem(RESUME_STORAGE_KEY);
  for (const key of LEGACY_RESUME_STORAGE_KEYS) {
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  }
}

function resumeStorage(privacyMode: MarketplacePrivacyMode): Storage {
  return privacyMode === "strict" ? window.sessionStorage : window.localStorage;
}

function progressPercent(task: MarketplaceDashboardSnapshot["artifactTasks"][number]): number {
  if (task.status === "completed") return 100;
  if (task.progress.totalBytes < 1) return 0;
  return Math.min(99, Math.floor(task.progress.processedBytes / task.progress.totalBytes * 100));
}

function phaseLabel(phase: UploadState["phase"]): string {
  return ({ idle: "准备上传", hashing: "正在校验分块…", uploading: "正在加密上传…", queuing: "正在创建任务…" })[phase];
}

function taskStatusLabel(status: string): string {
  return ({ queued: "排队中", claimed: "已领取", running: "处理中", completed: "已完成", failed: "失败", cancelled: "已取消" } as Record<string, string>)[status] ?? status;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

function formatMicros(value: string): string {
  const micros = BigInt(value);
  return `¥ ${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0").slice(0, 4)}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function shortDigest(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function readApiError(value: unknown): string {
  if (value && typeof value === "object" && "error" in value) {
    const error = (value as MarketplaceApiErrorBody).error;
    return `${error.message}（${error.code}）`;
  }
  return "服务返回了无法识别的响应";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
