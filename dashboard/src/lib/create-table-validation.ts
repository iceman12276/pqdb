export interface CreateTableColumn {
  name: string;
  data_type: string;
  sensitivity: string;
  is_owner: boolean;
}

const VALID_DATA_TYPES = [
  "text",
  "integer",
  "bigint",
  "boolean",
  "uuid",
  "timestamptz",
  "jsonb",
  "vector",
];

const VALID_SENSITIVITIES = ["plain", "searchable", "private"];

const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/;
const COLUMN_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Returns null if valid, or an error message string.
 */
export function validateTableName(name: string): string | null {
  if (!name) return "Table name is required";
  if (!/^[a-z]/.test(name)) return "Must start with a lowercase letter";
  if (!TABLE_NAME_RE.test(name))
    return "Only lowercase letters, digits, and underscores allowed";
  return null;
}

/**
 * Returns null if all columns are valid, or an error message string.
 */
export function validateColumns(columns: CreateTableColumn[]): string | null {
  if (columns.length === 0) return "At least one column is required";

  const seen = new Set<string>();
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const label = `Column ${i + 1}`;

    if (!col.name) return `${label}: name is required`;
    if (!COLUMN_NAME_RE.test(col.name))
      return `${label}: only lowercase letters, digits, and underscores allowed`;
    if (!col.data_type) return `${label}: data type is required`;
    if (!VALID_DATA_TYPES.includes(col.data_type))
      return `${label}: invalid data type "${col.data_type}"`;
    if (!VALID_SENSITIVITIES.includes(col.sensitivity))
      return `${label}: invalid sensitivity "${col.sensitivity}"`;

    if (seen.has(col.name)) return `Duplicate column name "${col.name}"`;
    seen.add(col.name);
  }

  return null;
}
