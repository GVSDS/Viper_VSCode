import { main } from 'vipeye-internal/nodeMain';

// Command line version doesn't use any worker threads.
main(/* maxWorkers */ 0);
