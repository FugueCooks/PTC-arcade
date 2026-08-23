export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function createLogger(base: LogFields): Logger {
  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    const record = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...base, ...safeFields(fields) });
    if (level === 'error') console.error(record);
    else if (level === 'warn') console.warn(record);
    else console.log(record);
  };
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields)
  };
}

function safeFields(fields: LogFields): LogFields {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !/(token|secret|rom|filePath|password)/i.test(key)));
}
