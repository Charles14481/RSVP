/**
 * Models and the ONNX files used on each backend. Chosen after listing the
 * Hugging Face repos (see DECISIONS.md): on WASM the 8-bit merged decoder is
 * by far the smallest 8-bit file in both repos.
 */

export type Backend = 'webgpu' | 'wasm';
export type BackendPreference = 'auto' | 'wasm';

export interface ModelFile {
  /** Base file name in onnx/, without dtype suffix or extension. */
  file: string;
  dtype: 'fp32' | 'fp16' | 'q8';
  /** Download size in MB, for the progress UI before byte counts arrive. */
  mb: number;
}

export interface ModelSpec {
  id: string;
  label: string;
  description: string;
  /** Mean word surprisal in bits on the sample prose (fp32 and 8-bit averaged); seeds the running mean. */
  meanBits: number;
  /** Maximum context length in tokens. */
  maxPositions: number;
  webgpuFp16: ModelFile;
  webgpuFp32: ModelFile;
  wasm: ModelFile;
}

export const MODELS: readonly ModelSpec[] = [
  {
    id: 'Xenova/gpt2',
    label: 'GPT-2 small',
    description: '124M parameters. The default: small models track human reading times best.',
    meanBits: 6.7,
    maxPositions: 1024,
    webgpuFp16: { file: 'model', dtype: 'fp16', mb: 251 },
    webgpuFp32: { file: 'model', dtype: 'fp32', mb: 500 },
    wasm: { file: 'decoder_model_merged', dtype: 'q8', mb: 128 },
  },
  {
    id: 'Xenova/distilgpt2',
    label: 'DistilGPT-2',
    description: '82M parameters. Smaller download and faster scoring.',
    meanBits: 7.5,
    maxPositions: 1024,
    webgpuFp16: { file: 'model', dtype: 'fp16', mb: 164 },
    webgpuFp32: { file: 'model', dtype: 'fp32', mb: 328 },
    wasm: { file: 'decoder_model_merged', dtype: 'q8', mb: 85 },
  },
];

export const DEFAULT_MODEL_ID = MODELS[0].id;

export function modelSpec(id: string): ModelSpec {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export interface WindowConfig {
  window: number;
  stride: number;
}

/** Logits are W x 50,257 float32 (about 100 MB at W = 512), so WASM gets a smaller window. */
export const DEFAULT_WINDOWS: Record<Backend, WindowConfig> = {
  webgpu: { window: 512, stride: 256 },
  wasm: { window: 256, stride: 128 },
};

/** Clamp a requested window to what the model supports, keeping S <= W. */
export function resolveWindow(spec: ModelSpec, backend: Backend, override?: Partial<WindowConfig>): WindowConfig {
  const base = DEFAULT_WINDOWS[backend];
  const window = Math.max(32, Math.min(spec.maxPositions, Math.round(override?.window ?? base.window)));
  const stride = Math.max(1, Math.min(window, Math.round(override?.stride ?? Math.floor(window / 2))));
  return { window, stride };
}
