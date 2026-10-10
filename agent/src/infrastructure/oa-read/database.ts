import mysql, { type PoolConnection, type RowDataPacket } from "mysql2/promise";
import type { OaReadConfig } from "../../config/oaReadConfig.js";
import { databaseErrorCode, isTransientDatabaseError } from './databaseErrors.js';
import { withReadRetry } from '../tools/readRetry.js';

export type SqlValue = string | number | boolean | null;
export type ReadQuery = <T extends RowDataPacket = RowDataPacket>(sql: string, values?: SqlValue[]) => Promise<T[]>;
export class ReadDatabase {
  private readonly pool;
  constructor(readonly config: OaReadConfig) {
    const u = new URL(config.databaseUrl);
    this.pool = mysql.createPool({
      host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database: u.pathname.slice(1),
      connectTimeout: config.queryTimeoutMs, connectionLimit: config.concurrency,
      waitForConnections: false, multipleStatements: false, flags: ["-LOCAL_FILES"],
      supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
      maxPreparedStatements: 64,
    } as mysql.PoolOptions);
  }
  async read<T>(operation: (query: ReadQuery) => Promise<T>, options: { retry?: boolean; onRetry?: () => void } = {}): Promise<T> {
    // Background metadata synchronization already owns its retry policy.
    if (!options.retry) return this.readOnce(operation, this.config.queryTimeoutMs, false);
    const result = await withReadRetry(remainingMs => this.readOnce(operation, remainingMs, true), {
      readOnly: true, timeoutMs: this.config.queryTimeoutMs,
      isRetryableError: error => isTransientDatabaseError(error) && databaseErrorCode(error) !== 'ER_QUERY_TIMEOUT',
      onRetry: options.onRetry,
    });
    return result.value;
  }
  private async readOnce<T>(operation: (query: ReadQuery) => Promise<T>, timeoutMs: number, bounded: boolean): Promise<T> {
    const deadline = bounded ? performance.now() + timeoutMs : Infinity;
    let acquisitionExpired = false;
    let acquisitionTimer: NodeJS.Timeout | undefined;
    const acquisition = this.pool.getConnection().then(connection => {
      if (acquisitionExpired) connection.destroy();
      return connection;
    });
    const connection = await Promise.race([
      acquisition,
      new Promise<never>((_, reject) => {
        acquisitionTimer = setTimeout(() => { acquisitionExpired = true; reject(readTimeout()); }, timeoutMs);
      }),
    ]).finally(() => clearTimeout(acquisitionTimer));
    const query: ReadQuery = async <R extends RowDataPacket>(sql: string, values: SqlValue[] = []) => {
      const remainingMs = bounded ? Math.ceil(deadline - performance.now()) : timeoutMs;
      if (remainingMs <= 0) throw readTimeout();
      const timer = setTimeout(() => connection.destroy(), remainingMs);
      try {
        const [rows] = values.length
          ? await connection.execute<R[]>({ sql, timeout: remainingMs }, values)
          : await connection.query<R[]>({ sql, timeout: remainingMs });
        return rows;
      } catch (error) {
        if (performance.now() >= deadline) throw readTimeout();
        throw error;
      } finally { clearTimeout(timer); }
    };
    try {
      await query(`SET SESSION MAX_EXECUTION_TIME = ${timeoutMs}`);
      await query("SET SESSION time_zone = '+08:00'");
      await query("START TRANSACTION READ ONLY");
      return await operation(query);
    } finally {
      await rollbackAndRelease(connection);
    }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

const readTimeout = () => Object.assign(new Error('只读查询时间预算已耗尽'), { code: 'ER_QUERY_TIMEOUT' });

async function rollbackAndRelease(connection: PoolConnection) {
  try { await connection.query({ sql: "ROLLBACK", timeout: 1000 }); connection.release(); }
  catch { connection.destroy(); }
}

export function quoteIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}
