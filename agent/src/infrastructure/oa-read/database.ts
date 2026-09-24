import mysql, { type PoolConnection, type RowDataPacket } from "mysql2/promise";
import type { OaReadConfig } from "../../config/oaReadConfig.js";

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
  async read<T>(operation: (query: ReadQuery) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    const query: ReadQuery = async <R extends RowDataPacket>(sql: string, values: SqlValue[] = []) => {
      const timer = setTimeout(() => connection.destroy(), this.config.queryTimeoutMs + 1000);
      try {
        const [rows] = values.length
          ? await connection.execute<R[]>({ sql, timeout: this.config.queryTimeoutMs }, values)
          : await connection.query<R[]>({ sql, timeout: this.config.queryTimeoutMs });
        return rows;
      } finally { clearTimeout(timer); }
    };
    try {
      await query(`SET SESSION MAX_EXECUTION_TIME = ${this.config.queryTimeoutMs}`);
      await query("SET SESSION time_zone = '+08:00'");
      await query("START TRANSACTION READ ONLY");
      return await operation(query);
    } finally {
      await rollbackAndRelease(connection);
    }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

async function rollbackAndRelease(connection: PoolConnection) {
  try { await connection.query({ sql: "ROLLBACK", timeout: 1000 }); connection.release(); }
  catch { connection.destroy(); }
}

export function quoteIdentifier(value: string): string {
  return `\`${value.replace(/`/g, "``")}\``;
}
