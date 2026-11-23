/**
 * SQL Server -> Postgres type mapping.
 *
 * Every mapping is explicit so the wizard can show it, let the user edit
 * it, and warn about lossy conversions before anything is created.
 *
 * MySQL mappings live in mapMysqlType below and share the MappedType
 * shape; mapSourceType dispatches on the migration source.
 */

export interface MappedType {
  /** Postgres type expression, e.g. `varchar(100)`, `numeric(10,2)`. */
  pgType: string;
  /** Human-readable warning shown in the UI, if the conversion is lossy
   *  or needs a manual decision. Undefined = clean mapping. */
  warning?: string;
  /** True when the mapping is only a best effort and must be reviewed. */
  needsReview?: boolean;
}

/** Every migration source the engine supports. */
export type SourceKind = 'sqlserver' | 'mysql' | 'postgres' | 'oracle' | 'sqlite';

export interface SqlServerColumnType {
  dataType: string; // e.g. nvarchar, decimal, datetime2
  maxLength: number | null; // CHARACTER_MAXIMUM_LENGTH (-1 = MAX)
  numericPrecision: number | null;
  numericScale: number | null;
  datetimePrecision: number | null;
}

export function mapSqlServerType(col: SqlServerColumnType): MappedType {
  const t = col.dataType.toLowerCase();
  const len = col.maxLength;
  const p = col.numericPrecision;
  const s = col.numericScale;

  switch (t) {
    // ── Integers ────────────────────────────────────────────────────
    case 'tinyint': return { pgType: 'smallint' };
    case 'smallint': return { pgType: 'smallint' };
    case 'int': return { pgType: 'integer' };
    case 'bigint': return { pgType: 'bigint' };

    // ── Exact numerics ──────────────────────────────────────────────
    case 'bit': return { pgType: 'boolean' };
    case 'decimal':
    case 'numeric':
      return { pgType: `numeric(${p ?? 18},${s ?? 0})` };
    case 'money':
      return {
        pgType: 'numeric(19,4)',
        warning: 'money has no Postgres equivalent; mapped to numeric(19,4). Currency formatting is lost.',
      };
    case 'smallmoney':
      return {
        pgType: 'numeric(10,4)',
        warning: 'smallmoney has no Postgres equivalent; mapped to numeric(10,4).',
      };

    // ── Approximate numerics ────────────────────────────────────────
    case 'float': return { pgType: 'double precision' };
    case 'real': return { pgType: 'real' };

    // ── Date / time ─────────────────────────────────────────────────
    case 'date': return { pgType: 'date' };
    case 'time': return { pgType: `time(${col.datetimePrecision ?? 7})` };
    case 'datetime': return { pgType: 'timestamp' };
    case 'datetime2': return { pgType: 'timestamptz' };
    case 'datetimeoffset':
      return {
        pgType: 'timestamptz',
        warning: 'datetimeoffset stores an explicit offset; timestamptz normalises to UTC. The instant is preserved, the original offset text is not.',
      };
    case 'smalldatetime': return { pgType: 'timestamp' };

    // ── Character strings ───────────────────────────────────────────
    case 'char':
      return { pgType: len === -1 ? 'text' : `char(${len ?? 1})` };
    case 'varchar':
      return { pgType: len === -1 ? 'text' : `varchar(${len})` };
    case 'text':
      return { pgType: 'text', warning: 'text is deprecated in SQL Server; mapped to Postgres text.' };
    case 'nchar':
      return { pgType: len === -1 ? 'text' : `char(${len ?? 1})` };
    case 'nvarchar':
      return { pgType: len === -1 ? 'text' : `varchar(${len})` };
    case 'ntext':
      return { pgType: 'text', warning: 'ntext is deprecated in SQL Server; mapped to Postgres text.' };

    // ── Binary ──────────────────────────────────────────────────────
    case 'binary':
      return { pgType: 'bytea', warning: 'Fixed-length binary becomes variable-length bytea; trailing zero padding is not preserved.' };
    case 'varbinary':
      return { pgType: 'bytea' };
    case 'image':
      return { pgType: 'bytea', warning: 'image is deprecated in SQL Server; mapped to bytea.' };

    // ── Other ───────────────────────────────────────────────────────
    case 'uniqueidentifier': return { pgType: 'uuid' };
    case 'xml':
      return { pgType: 'xml', warning: 'Postgres xml does not enforce the SQL Server XML schema collection; validation is lost.' };
    case 'sql_variant':
      return {
        pgType: 'text',
        needsReview: true,
        warning: 'sql_variant has no Postgres equivalent. Values are cast to text; review per-column before migrating.',
      };
    case 'hierarchyid':
      return {
        pgType: 'text',
        needsReview: true,
        warning: 'hierarchyid has no Postgres equivalent. Stored as its string form; hierarchy methods (GetAncestor, etc.) do not exist in Postgres.',
      };
    case 'geography':
      return {
        pgType: 'geography',
        needsReview: true,
        warning: 'Requires the PostGIS extension (CREATE EXTENSION postgis) on the NHost database. Spatial methods differ; verify queries after migration. NHost Postgres does not enable PostGIS by default — enable it in the NHost dashboard first.',
      };
    case 'geometry':
      return {
        pgType: 'geometry',
        needsReview: true,
        warning: 'Requires the PostGIS extension (CREATE EXTENSION postgis). See geography note.',
      };
    case 'timestamp':
    case 'rowversion':
      return {
        pgType: 'bytea',
        needsReview: true,
        warning: 'rowversion/timestamp is an auto-incrementing binary, not a time. Mapped to bytea; it will NOT auto-increment in Postgres. Consider dropping it or replacing it with a trigger-managed value.',
      };

    default:
      return {
        pgType: 'text',
        needsReview: true,
        warning: `Unknown SQL Server type "${col.dataType}" — defaulted to text. Review before migrating.`,
      };
  }
}

/** Default mapping for a column row as returned by INFORMATION_SCHEMA. */
export function defaultPgTypeFor(dataType: string): string {
  return mapSqlServerType({
    dataType,
    maxLength: null,
    numericPrecision: null,
    numericScale: null,
    datetimePrecision: null,
  }).pgType;
}

/** All known SQL Server types, for the editable mapping dropdown. */
export const KNOWN_SQLSERVER_TYPES = [
  'tinyint', 'smallint', 'int', 'bigint', 'bit', 'decimal', 'numeric',
  'money', 'smallmoney', 'float', 'real', 'date', 'time', 'datetime',
  'datetime2', 'datetimeoffset', 'smalldatetime', 'char', 'varchar',
  'text', 'nchar', 'nvarchar', 'ntext', 'binary', 'varbinary', 'image',
  'uniqueidentifier', 'xml', 'sql_variant', 'hierarchyid', 'geography',
  'geometry', 'timestamp',
] as const;

// ── MySQL -> Postgres ────────────────────────────────────────────────

export interface MysqlColumnType {
  dataType: string; // e.g. tinyint, varchar, datetime
  /** COLUMN_TYPE, e.g. `tinyint(1)`, `int unsigned`, `enum('a','b')`. */
  columnType?: string | null;
  maxLength: number | null; // CHARACTER_MAXIMUM_LENGTH
  numericPrecision: number | null;
  numericScale: number | null;
  datetimePrecision: number | null;
}

/** MySQL -> Postgres. `columnType` matters: `tinyint(1)` is MySQL's
 *  boolean, and `int unsigned` exceeds Postgres `integer`. */
export function mapMysqlType(col: MysqlColumnType): MappedType {
  const t = col.dataType.toLowerCase();
  const ct = (col.columnType ?? '').toLowerCase();
  const len = col.maxLength;
  const p = col.numericPrecision;
  const s = col.numericScale;
  const unsigned = /\bunsigned\b/.test(ct);

  switch (t) {
    // ── Integers ────────────────────────────────────────────────────
    case 'tinyint':
      // tinyint(1) is how MySQL/ORMs store booleans.
      if (/^tinyint\(1\)/.test(ct)) return { pgType: 'boolean' };
      return { pgType: unsigned ? 'smallint' : 'smallint' };
    case 'smallint':
      return { pgType: unsigned ? 'integer' : 'smallint' };
    case 'mediumint':
      return { pgType: 'integer' };
    case 'int':
    case 'integer':
      // int unsigned goes to 4,294,967,295 — past integer's max.
      return { pgType: unsigned ? 'bigint' : 'integer' };
    case 'bigint':
      return unsigned
        ? {
            pgType: 'numeric(20)',
            warning: 'bigint unsigned exceeds Postgres bigint (max 9.2e18); mapped to numeric(20) so no values are lost.',
          }
        : { pgType: 'bigint' };

    // ── Exact / approximate numerics ────────────────────────────────
    case 'bit': {
      const m = ct.match(/^bit\((\d+)\)/);
      const bits = m ? Number(m[1]) : 1;
      return bits === 1
        ? { pgType: 'boolean' }
        : { pgType: `bit(${bits})`, warning: `bit(${bits}) maps to Postgres bit(${bits}); bit-string operations differ from MySQL.` };
    }
    case 'decimal':
    case 'numeric':
      return { pgType: `numeric(${p ?? 10},${s ?? 0})` };
    case 'float': return { pgType: 'real' };
    case 'double':
    case 'double precision': return { pgType: 'double precision' };

    // ── Date / time ─────────────────────────────────────────────────
    case 'date': return { pgType: 'date' };
    case 'time': return { pgType: `time(${col.datetimePrecision ?? 0})` };
    // DATETIME carries no timezone in MySQL; TIMESTAMP does (it is
    // stored in UTC and converted to the session zone).
    case 'datetime': return { pgType: 'timestamp' };
    case 'timestamp': return { pgType: 'timestamptz' };
    case 'year': return { pgType: 'smallint' };

    // ── Character strings ───────────────────────────────────────────
    case 'char':
      return { pgType: `char(${len ?? 1})` };
    case 'varchar':
      return { pgType: `varchar(${len})` };
    case 'tinytext':
    case 'text':
    case 'mediumtext':
    case 'longtext':
      return { pgType: 'text' };
    case 'enum':
      return {
        pgType: 'text',
        warning: `${ct || 'enum'} has no Postgres equivalent; mapped to text. The allowed values are not enforced — add a CHECK constraint if you need them enforced.`,
      };
    case 'set':
      return {
        pgType: 'text',
        warning: 'set has no Postgres equivalent; mapped to text holding the comma-separated values.',
      };

    // ── Binary ──────────────────────────────────────────────────────
    case 'binary':
    case 'varbinary':
    case 'tinyblob':
    case 'blob':
    case 'mediumblob':
    case 'longblob':
      return { pgType: 'bytea' };

    // ── Other ───────────────────────────────────────────────────────
    case 'json':
      return { pgType: 'jsonb', warning: 'MySQL JSON maps to jsonb; key order is not preserved and duplicate keys are dropped.' };
    case 'geometry':
    case 'point':
    case 'linestring':
    case 'polygon':
    case 'multipoint':
    case 'multilinestring':
    case 'multipolygon':
    case 'geometrycollection':
      return {
        pgType: 'geometry',
        needsReview: true,
        warning: 'Requires the PostGIS extension (CREATE EXTENSION postgis) on the target. Spatial methods differ; verify queries after migration. NHost Postgres does not enable PostGIS by default — enable it in the NHost dashboard first.',
      };

    default:
      return {
        pgType: 'text',
        needsReview: true,
        warning: `Unknown MySQL type "${col.dataType}" — defaulted to text. Review before migrating.`,
      };
  }
}

/** All known MySQL types, for the editable mapping dropdown. */
export const KNOWN_MYSQL_TYPES = [
  'tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'bit', 'decimal',
  'numeric', 'float', 'double', 'date', 'time', 'datetime', 'timestamp',
  'year', 'char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext',
  'enum', 'set', 'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob',
  'longblob', 'json', 'geometry', 'point', 'linestring', 'polygon',
] as const;

/** Dispatch on the migration source. `col` is the shared ColumnInfo
 *  shape (dataType / lengths / sourceExtra):
 *  - sqlserver: dataType is the T-SQL type, sourceExtra unused.
 *  - mysql: sourceExtra is COLUMN_TYPE (`tinyint(1)`, `int unsigned`).
 *  - postgres: dataType is information_schema's data_type
 *    (`character varying`, `timestamp with time zone`, `ARRAY`),
 *    sourceExtra is udt_name (`_int4`, `geography`).
 *  - oracle: dataType is ALL_TAB_COLUMNS.DATA_TYPE (`VARCHAR2`,
 *    `NUMBER`, `TIMESTAMP(6) WITH TIME ZONE`), lengths from
 *    CHAR_LENGTH / DATA_PRECISION / DATA_SCALE.
 *  - sqlite: dataType is the declared type's base word, sourceExtra
 *    is the full declared type (`VARCHAR(255)`, `DECIMAL(10,2)`). */
export function mapSourceType(
  source: SourceKind,
  col: {
    dataType: string;
    sourceExtra?: string | null;
    maxLength: number | null;
    numericPrecision: number | null;
    numericScale: number | null;
    datetimePrecision: number | null;
  },
): MappedType {
  switch (source) {
    case 'mysql':
      return mapMysqlType({
        dataType: col.dataType,
        columnType: col.sourceExtra,
        maxLength: col.maxLength,
        numericPrecision: col.numericPrecision,
        numericScale: col.numericScale,
        datetimePrecision: col.datetimePrecision,
      });
    case 'postgres':
      return mapPostgresType({
        dataType: col.dataType,
        udtName: col.sourceExtra,
        maxLength: col.maxLength,
        numericPrecision: col.numericPrecision,
        numericScale: col.numericScale,
        datetimePrecision: col.datetimePrecision,
      });
    case 'oracle':
      return mapOracleType({
        dataType: col.dataType,
        maxLength: col.maxLength,
        numericPrecision: col.numericPrecision,
        numericScale: col.numericScale,
        datetimePrecision: col.datetimePrecision,
      });
    case 'sqlite':
      return mapSqliteType({ declaredType: col.sourceExtra ?? col.dataType });
    default:
      return mapSqlServerType({
        dataType: col.dataType,
        maxLength: col.maxLength,
        numericPrecision: col.numericPrecision,
        numericScale: col.numericScale,
        datetimePrecision: col.datetimePrecision,
      });
  }
}

// ── PostgreSQL -> PostgreSQL ─────────────────────────────────────────

/**
 * A Postgres source already speaks Postgres, so this is mostly
 * normalisation: information_schema's `character varying` becomes
 * `varchar(n)`, `timestamp with time zone` becomes `timestamptz`,
 * `ARRAY` becomes the element type with `[]` (from udt_name).
 * User-defined types (extensions, enums, domains) fall back to text
 * with a warning, except PostGIS geography/geometry which pass
 * through with the usual PostGIS note.
 */
export function mapPostgresType(col: {
  dataType: string;
  udtName?: string | null;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  datetimePrecision: number | null;
}): MappedType {
  // udt_name uses Postgres internal names (int4, bool, bpchar) —
  // normalise them to the information_schema names the switch uses.
  const internal: Record<string, string> = {
    int2: 'smallint', int4: 'integer', int8: 'bigint',
    float4: 'real', float8: 'double precision', bool: 'boolean',
    bpchar: 'character', varchar: 'character varying',
  };
  const t = internal[col.dataType.toLowerCase()] ?? col.dataType.toLowerCase();
  const udt = (col.udtName ?? '').toLowerCase();
  const len = col.maxLength;
  const p = col.numericPrecision;
  const s = col.numericScale;

  switch (t) {
    case 'smallint': return { pgType: 'smallint' };
    case 'integer': return { pgType: 'integer' };
    case 'bigint': return { pgType: 'bigint' };
    case 'numeric': return { pgType: `numeric(${p ?? 10},${s ?? 0})` };
    case 'real': return { pgType: 'real' };
    case 'double precision': return { pgType: 'double precision' };
    case 'money': return { pgType: 'money' };
    case 'boolean': return { pgType: 'boolean' };
    case 'date': return { pgType: 'date' };
    case 'time without time zone': return { pgType: `time(${col.datetimePrecision ?? 6})` };
    case 'time with time zone': return { pgType: `timetz(${col.datetimePrecision ?? 6})` };
    case 'timestamp without time zone': return { pgType: 'timestamp' };
    case 'timestamp with time zone': return { pgType: 'timestamptz' };
    case 'interval': return { pgType: 'interval' };
    case 'character': return { pgType: `char(${len ?? 1})` };
    case 'character varying': return { pgType: len ? `varchar(${len})` : 'text' };
    case 'text': return { pgType: 'text' };
    case 'bytea': return { pgType: 'bytea' };
    case 'uuid': return { pgType: 'uuid' };
    case 'json': return { pgType: 'json' };
    case 'jsonb': return { pgType: 'jsonb' };
    case 'xml': return { pgType: 'xml' };
    case 'bit': return { pgType: 'bit(1)' };
    case 'bit varying': return { pgType: 'varbit' };
    case 'array': {
      // udt_name is the array type, e.g. _int4, _text, _varchar.
      const base = udt.replace(/^_/, '');
      const inner = mapPostgresType({ dataType: base, maxLength: len, numericPrecision: p, numericScale: s, datetimePrecision: col.datetimePrecision });
      return { pgType: `${inner.pgType}[]`, warning: inner.warning };
    }
    case 'user-defined':
      if (udt === 'geography' || udt === 'geometry') {
        return {
          pgType: udt,
          needsReview: true,
          warning: 'Requires the PostGIS extension (CREATE EXTENSION postgis) on the target. NHost Postgres does not enable PostGIS by default — enable it in the NHost dashboard first.',
        };
      }
      return {
        pgType: 'text',
        needsReview: true,
        warning: `User-defined type "${col.udtName ?? col.dataType}" (enum, domain or extension type) — mapped to text. Casts and checks on it do not carry over; review before migrating.`,
      };
    default:
      return {
        pgType: 'text',
        needsReview: true,
        warning: `Unknown Postgres type "${col.dataType}" — defaulted to text. Review before migrating.`,
      };
  }
}

// ── Oracle -> PostgreSQL ─────────────────────────────────────────────

export function mapOracleType(col: {
  dataType: string;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  datetimePrecision: number | null;
}): MappedType {
  const t = col.dataType.toUpperCase().replace(/\s*\(.*\)$/, '');
  const len = col.maxLength;
  const p = col.numericPrecision;
  const s = col.numericScale ?? 0;

  switch (t) {
    case 'NUMBER': {
      // NUMBER with no precision/scale is Oracle's "any number".
      if (p === null || p === undefined) return { pgType: 'numeric' };
      if (s === 0) {
        if (p <= 4) return { pgType: 'smallint' };
        if (p <= 9) return { pgType: 'integer' };
        if (p <= 18) return { pgType: 'bigint' };
        return { pgType: 'numeric' };
      }
      return { pgType: `numeric(${p},${s})` };
    }
    case 'BINARY_FLOAT': return { pgType: 'real' };
    case 'BINARY_DOUBLE': return { pgType: 'double precision' };
    case 'FLOAT': return { pgType: 'double precision' };
    case 'VARCHAR2':
    case 'VARCHAR': return { pgType: len ? `varchar(${len})` : 'text' };
    case 'NVARCHAR2':
    case 'NVARCHAR': return { pgType: len ? `varchar(${len})` : 'text' };
    case 'CHAR':
    case 'NCHAR': return { pgType: `char(${len ?? 1})` };
    case 'CLOB':
    case 'NCLOB': return { pgType: 'text' };
    case 'LONG': return { pgType: 'text', warning: 'LONG is deprecated in Oracle; mapped to text.' };
    case 'DATE': return { pgType: 'timestamp' };
    case 'TIMESTAMP': return { pgType: 'timestamp' };
    case 'TIMESTAMP WITH TIME ZONE': return { pgType: 'timestamptz' };
    case 'TIMESTAMP WITH LOCAL TIME ZONE':
      return {
        pgType: 'timestamptz',
        warning: 'TIMESTAMP WITH LOCAL TIME ZONE is stored in the database timezone in Oracle; timestamptz normalises to UTC. The instant is preserved, the session-zone behaviour is not.',
      };
    case 'INTERVAL YEAR TO MONTH':
    case 'INTERVAL DAY TO SECOND': return { pgType: 'interval' };
    case 'RAW':
    case 'LONG RAW':
    case 'BLOB': return { pgType: 'bytea' };
    case 'BFILE':
      return {
        pgType: 'text',
        needsReview: true,
        warning: 'BFILE is a pointer to a file outside the database — only the file path is copied, not the file itself.',
      };
    case 'ROWID':
    case 'UROWID':
      return {
        pgType: 'text',
        needsReview: true,
        warning: 'ROWID is a physical address in the Oracle database; it is meaningless in Postgres. Kept as text — consider dropping it.',
      };
    case 'XMLTYPE':
      return { pgType: 'xml', warning: 'Postgres xml does not enforce the Oracle XML schema; validation is lost.' };
    case 'SDO_GEOMETRY':
      return {
        pgType: 'geometry',
        needsReview: true,
        warning: 'Oracle Spatial (SDO_GEOMETRY) has no direct Postgres equivalent. Mapped to PostGIS geometry — enable PostGIS on the target and verify the geometry values after migration.',
      };
    default:
      return {
        pgType: 'text',
        needsReview: true,
        warning: `Unknown Oracle type "${col.dataType}" — defaulted to text. Review before migrating.`,
      };
  }
}

// ── SQLite -> PostgreSQL ─────────────────────────────────────────────

/**
 * SQLite has flexible typing: a column's declared type is free text
 * ("VARCHAR(255)", "UNSIGNED BIG INT", "DOUBLE PRECISION", "DATETIME")
 * and the storage class follows affinity rules. Parse the declared
 * type; fall back to affinity (INT → integer, CHAR/CLOB/TEXT → text,
 * BLOB/empty → bytea, REAL/FLOA/DOUB → double precision, otherwise
 * numeric).
 */
export function mapSqliteType(col: { declaredType: string }): MappedType {
  const raw = (col.declaredType ?? '').trim().toUpperCase();
  if (!raw) return { pgType: 'bytea', warning: 'No declared type — SQLite stores any value here; mapped to bytea. Review before migrating.' };
  const m = raw.match(/^([A-Z ]+?)(?:\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/);
  const base = (m?.[1] ?? raw).trim();
  const n1 = m?.[2] ? Number(m[2]) : null;
  const n2 = m?.[3] ? Number(m[3]) : null;

  if (base === 'BOOLEAN' || base === 'BOOL') return { pgType: 'boolean' };
  if (base === 'DATE') return { pgType: 'date' };
  if (base === 'DATETIME') return { pgType: 'timestamp' };
  if (base === 'TIME') return { pgType: 'time' };
  if (base === 'TIMESTAMP') return { pgType: 'timestamp' };
  if (base === 'VARCHAR' || base === 'CHARACTER VARYING') return { pgType: n1 ? `varchar(${n1})` : 'text' };
  if (base === 'CHAR' || base === 'CHARACTER' || base === 'NCHAR') return { pgType: `char(${n1 ?? 1})` };
  if (base === 'TEXT' || base === 'CLOB') return { pgType: 'text' };
  if (base === 'DECIMAL' || base === 'NUMERIC') return { pgType: n1 !== null ? `numeric(${n1},${n2 ?? 0})` : 'numeric' };
  if (base === 'BIGINT' || base === 'UNSIGNED BIG INT' || base === 'INT8') return { pgType: 'bigint' };
  if (base === 'SMALLINT' || base === 'INT2') return { pgType: 'smallint' };
  if (base === 'TINYINT' || base === 'INT1') return { pgType: 'smallint' };
  if (base === 'MEDIUMINT' || base === 'INT3') return { pgType: 'integer' };
  if (base === 'DOUBLE' || base === 'DOUBLE PRECISION') return { pgType: 'double precision' };
  if (base === 'REAL' || base === 'FLOAT') return { pgType: 'double precision' };
  if (base === 'BLOB') return { pgType: 'bytea' };
  if (base === 'UUID') return { pgType: 'uuid' };
  if (base === 'JSON') return { pgType: 'jsonb' };

  // Affinity fallback (SQLite docs, section 3.1).
  if (base.includes('INT')) return { pgType: 'integer' };
  if (base.includes('CHAR') || base.includes('CLOB') || base.includes('TEXT')) return { pgType: 'text' };
  if (base.includes('BLOB') || base === '') return { pgType: 'bytea' };
  if (base.includes('REAL') || base.includes('FLOA') || base.includes('DOUB')) return { pgType: 'double precision' };
  return { pgType: 'numeric' };
}
