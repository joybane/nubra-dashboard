/**
 * Worker thread: decodes bucket files for the pool in bucketPool.ts. One message in per file
 * ({ id, file }), one out ({ id, cols } or { id, error }); the column buffers are transferred, not
 * copied.
 */
import { parentPort } from 'worker_threads';
import { decodeBucket } from './bucketDecode.ts';

if (!parentPort) throw new Error('parquetWorker must run as a worker thread');
const port = parentPort;

port.on('message', async (msg: { id: number; file: string }) => {
  try {
    const cols = await decodeBucket(msg.file);
    port.postMessage({ id: msg.id, cols }, [
      cols.ts.buffer,
      cols.open.buffer,
      cols.high.buffer,
      cols.low.buffer,
      cols.close.buffer,
      cols.strike.buffer,
    ] as ArrayBuffer[]);
  } catch (e) {
    port.postMessage({ id: msg.id, error: (e as Error).message });
  }
});
