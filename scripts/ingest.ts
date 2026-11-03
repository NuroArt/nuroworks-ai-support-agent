import { ingestAll } from '../src/lib/knowledge/ingest';

const force = process.argv.includes('--force');
ingestAll({ force })
  .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
