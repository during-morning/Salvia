import { isMainThread, workerData } from 'node:worker_threads';
import { runInternalFetch, startNovelWorker } from '@salvia/novel';
import { main } from './main.tsx';

// The packaged executable re-runs itself for a few internal jobs (it can't run `node -e`), and
// its bundle is also the script of the book-source worker threads.
if (process.env.SALVIA_INTERNAL === 'fetch') {
  runInternalFetch();
} else if (!isMainThread && (workerData as { salvia?: string } | undefined)?.salvia === 'novel-worker') {
  startNovelWorker();
} else {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
