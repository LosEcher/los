/** CLI 入口：`pnpm project:dsh-sessions` —— 见同目录 project-dsh-sessions.ts。 */
import { projectDshSessions } from './project-dsh-sessions.js';
process.exit(await projectDshSessions(process.argv.slice(2)));
