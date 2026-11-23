declare module 'pg-copy-streams' {
  import type { Query } from 'pg';
  import type { Duplex } from 'stream';

  /** A COPY ... FROM STDIN query: pass it to client.query() and write rows to it. */
  export function from(sql: string): Duplex & Query;
  /** A COPY ... TO STDOUT query: pass it to client.query() and read rows from it. */
  export function to(sql: string): Duplex & Query;
}
