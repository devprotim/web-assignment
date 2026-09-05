/**
 * NSFW classification worker.
 *
 * Runs in a worker thread because tfjs-node inference is synchronous CPU work.
 * Measured at ~99ms per image on this hardware; on the main thread that would
 * block every open WebSocket on the instance for the duration, so a handful of
 * concurrent uploads would visibly stall chat for everyone.
 *
 * The main thread does the decoding and resizing with sharp and sends raw RGB
 * pixels, so this file only ever touches TensorFlow.
 */
import { parentPort } from 'node:worker_threads';
import * as tf from '@tensorflow/tfjs-node';
import * as nsfw from 'nsfwjs';

export interface ClassifyRequest {
  id: number;
  /** Raw RGB pixels, 224 x 224 x 3, uint8. */
  pixels: Uint8Array;
  size: number;
}

export interface ClassifyResponse {
  id: number;
  scores?: Record<string, number>;
  error?: string;
}

if (!parentPort) throw new Error('nsfw.worker must be run as a worker thread');
const port = parentPort;

let model: nsfw.NSFWJS | null = null;

async function init(): Promise<void> {
  // The weights ship inside the nsfwjs package (MobileNetV2, ~3.4MB), so there
  // is no network call here and a deployed container has no external dependency
  // at startup.
  model = await nsfw.load();

  // Warm the graph with a throwaway inference. The first classify is markedly
  // slower than subsequent ones, and paying that cost at boot keeps it off the
  // first real user's request.
  const warm = tf.zeros([224, 224, 3], 'int32') as tf.Tensor3D;
  await model.classify(warm);
  warm.dispose();

  port.postMessage({ ready: true });
}

port.on('message', async (request: ClassifyRequest) => {
  if (!model) {
    port.postMessage({ id: request.id, error: 'model not loaded' } satisfies ClassifyResponse);
    return;
  }

  let tensor: tf.Tensor3D | null = null;
  try {
    tensor = tf.tensor3d(new Int32Array(request.pixels), [request.size, request.size, 3], 'int32');
    const predictions = await model.classify(tensor);

    const scores: Record<string, number> = {};
    for (const p of predictions) scores[p.className.toLowerCase()] = p.probability;

    port.postMessage({ id: request.id, scores } satisfies ClassifyResponse);
  } catch (error) {
    port.postMessage({
      id: request.id,
      error: (error as Error).message,
    } satisfies ClassifyResponse);
  } finally {
    // Tensors are not garbage collected; leaking them grows native memory until
    // the process is killed.
    tensor?.dispose();
  }
});

void init().catch((error: Error) => {
  port.postMessage({ ready: false, error: error.message });
});
