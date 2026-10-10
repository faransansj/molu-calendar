export type EngineKind = "litert";
export interface ModelArtifact {
  id: string;
  engine: EngineKind;
  revision: string;
}
export interface Model extends ModelArtifact {
  name: string;
  bytes: number;
  memoryMB: number;
}
export interface GPUAdapterInfoView {
  vendor?: string;
  architecture?: string;
  description?: string;
  isFallbackAdapter?: boolean;
  type?: string;
}
export interface GPUAdapterView {
  info?: GPUAdapterInfoView;
  isFallbackAdapter?: boolean;
  type?: string;
  features: ReadonlySet<string>;
  limits: Readonly<Record<string, number>>;
}
export const MODELS: Model[] = [
  {
    id: "gemma-4-E2B-it-web",
    name: "Gemma 4 E2B",
    engine: "litert",
    bytes: 2008432640,
    memoryMB: 1800,
    revision: "b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1",
  },
];
export const DEFAULT_MODEL_ID = "gemma-4-E2B-it-web";
export const LITERT_ASSET_PATH = "/vendor/litert-lm/0.17.1/";
export const LITERT_CACHE = "molu/litert-model-v1";
export const ENGINE_NAMES = { litert: "LiteRT-LM" };
export const MODEL_CATALOG_VERSION = "litert-0.17.1-ko-v3";
export const MODEL_CONTEXT = 4096;
export function runtimeCompatibility(adapter: GPUAdapterView) {
  if (
    adapter.info?.isFallbackAdapter ??
    adapter.isFallbackAdapter ??
    (adapter.info?.type === "software" || adapter.type === "software")
  )
    return "소프트웨어 GPU 어댑터는 지원하지 않습니다. GPU 가속 브라우저에서 다시 확인해 주세요.";
  return null;
}

export const modelCardURL = () =>
  "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm";
export const modelURL = (model: ModelArtifact) =>
  `${modelCardURL()}/resolve/${model.revision}/${model.id}.litertlm`;
export const modelById = (id: string | null | undefined) =>
  MODELS.find((model) => model.id === id);
export const errorWithCode = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
