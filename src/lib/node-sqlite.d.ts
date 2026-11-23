/**
 * Minimal declarations for Node's built-in `node:sqlite` module.
 * The runtime (Node 24) ships it, but this project pins
 * @types/node 20, which predates the module. Keep this file until
 * @types/node is upgraded past 24.
 */
declare module 'node:sqlite' {
  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    location?: string;
  }
  export class StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
  }
  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
