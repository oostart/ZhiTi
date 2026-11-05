type TesseractWorker = {
  recognize: (image: string) => Promise<{ data: { text: string } }>
  terminate: () => Promise<unknown>
}

let cached: { lang: string; worker: TesseractWorker } | null = null
let initializing: Promise<TesseractWorker> | null = null

const WORKER_PATH = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js'
const CORE_PATH = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1'
const LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0'

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function createTesseractWorker(lang: string, onProgress?: (progress: number, status: string) => void): Promise<TesseractWorker> {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker(lang, 1, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: LANG_PATH,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress, '识别文字中')
      else if (m.progress > 0) {
        onProgress?.(m.progress, m.status === 'loading language traineddata' ? '加载语言模型' : '初始化 OCR')
      }
    }
  })
  return worker as unknown as TesseractWorker
}

/** 使用 Tesseract.js 对题目图片做 OCR（首次使用需联网下载语言模型） */
export async function recognizeImage(
  dataUrl: string,
  lang: string,
  onProgress?: (progress: number, status: string) => void
): Promise<string> {
  if (cached && cached.lang !== lang) {
    await cached.worker.terminate().catch(() => undefined)
    cached = null
  }
  if (!cached) {
    if (!initializing) {
      initializing = withTimeout(createTesseractWorker(lang, onProgress), 120_000, 'OCR 引擎初始化超时，请检查网络后重试（首次使用需下载语言模型）').then(
        (worker) => {
          cached = { lang, worker }
          return worker
        }
      )
    }
    try {
      await initializing
    } finally {
      initializing = null
    }
  }
  const worker = cached!.worker
  onProgress?.(0.05, '准备识别')
  const result = await withTimeout(worker.recognize(dataUrl), 180_000, 'OCR 识别超时，请重试或检查网络连接')
  return (result.data.text ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

export async function disposeOcr(): Promise<void> {
  if (cached) {
    await cached.worker.terminate().catch(() => undefined)
    cached = null
  }
}
