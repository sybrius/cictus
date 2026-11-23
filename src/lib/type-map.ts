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
 *  shape (dataType / lengths / sourceExtra = MySQL COLUMN_TYPE). */
export function mapSourceType(
  source: 'sqlserver' | 'mysql',
  col: {
    dataType: string;
    sourceExtra?: string | null;
    maxLength: number | null;
    numericPrecision: number | null;
    numericScale: number | null;
    datetimePrecision: number | null;
  },
): MappedType {
  if (source === 'mysql') {
    return mapMysqlType({
      dataType: col.dataType,
      columnType: col.sourceExtra,
      maxLength: col.maxLength,
      numericPrecision: col.numericPrecision,
      numericScale: col.numericScale,
      datetimePrecision: col.datetimePrecision,
    });
  }
  return mapSqlServerType({
    dataType: col.dataType,
    maxLength: col.maxLength,
    numericPrecision: col.numericPrecision,
    numericScale: col.numericScale,
    datetimePrecision: col.datetimePrecision,
  });
}
