import { startNovelWorker } from './worker.ts';

// Worker thread entry when running from source (the packaged build starts workers from its bundle).
startNovelWorker();
