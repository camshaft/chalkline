import { main, signalled } from './cli';

main(process.argv.slice(2), signalled()).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
