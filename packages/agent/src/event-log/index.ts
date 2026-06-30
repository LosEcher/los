export type {
  EventLogBackend,
  EventLogEntry,
  AppendEventInput,
  ReadEventsOptions,
  EventLogStats,
} from './types.js';

export { FileEventLogBackend, setEventLogBaseDir } from './file-backend.js';
