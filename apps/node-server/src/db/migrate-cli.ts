/** `pnpm db:migrate` 的入口：建表，然后退出。跑完即退，不起服务。 */
import { logger } from '../logger.js';
import { db, flavor } from './instance.js';
import { migrateDatabase } from './migrate.js';

await migrateDatabase(db, flavor, logger);
logger.info('db', 'migrations up to date');
process.exit(0);
