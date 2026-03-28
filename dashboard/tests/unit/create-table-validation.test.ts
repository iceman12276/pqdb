import { describe, it, expect } from "vitest";
import {
  validateTableName,
  validateColumns,
  type CreateTableColumn,
} from "~/lib/create-table-validation";

describe("validateTableName", () => {
  it("accepts a valid lowercase name", () => {
    expect(validateTableName("users")).toBeNull();
  });

  it("accepts name with underscores and digits", () => {
    expect(validateTableName("user_profiles_2")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateTableName("")).toBe("Table name is required");
  });

  it("rejects name starting with a digit", () => {
    expect(validateTableName("2users")).toBe(
      "Must start with a lowercase letter",
    );
  });

  it("rejects name starting with underscore", () => {
    expect(validateTableName("_users")).toBe(
      "Must start with a lowercase letter",
    );
  });

  it("rejects name with uppercase letters", () => {
    expect(validateTableName("Users")).toBe(
      "Must start with a lowercase letter",
    );
  });

  it("rejects name with hyphens", () => {
    expect(validateTableName("user-profiles")).toBe(
      "Only lowercase letters, digits, and underscores allowed",
    );
  });

  it("rejects name with spaces", () => {
    expect(validateTableName("user profiles")).toBe(
      "Only lowercase letters, digits, and underscores allowed",
    );
  });

  it("rejects name with special characters", () => {
    expect(validateTableName("users!")).toBe(
      "Only lowercase letters, digits, and underscores allowed",
    );
  });
});

describe("validateColumns", () => {
  const validColumn: CreateTableColumn = {
    name: "id",
    data_type: "uuid",
    sensitivity: "plain",
    is_owner: false,
  };

  it("accepts a valid column list", () => {
    expect(validateColumns([validColumn])).toBeNull();
  });

  it("rejects empty column list", () => {
    expect(validateColumns([])).toBe("At least one column is required");
  });

  it("rejects column with empty name", () => {
    expect(validateColumns([{ ...validColumn, name: "" }])).toBe(
      'Column 1: name is required',
    );
  });

  it("rejects column with invalid name characters", () => {
    expect(validateColumns([{ ...validColumn, name: "my-col" }])).toBe(
      "Column 1: only lowercase letters, digits, and underscores allowed",
    );
  });

  it("rejects column with empty data_type", () => {
    expect(validateColumns([{ ...validColumn, data_type: "" }])).toBe(
      "Column 1: data type is required",
    );
  });

  it("rejects column with invalid data_type", () => {
    expect(
      validateColumns([{ ...validColumn, data_type: "varchar" }]),
    ).toBe("Column 1: invalid data type \"varchar\"");
  });

  it("rejects column with invalid sensitivity", () => {
    expect(
      validateColumns([{ ...validColumn, sensitivity: "secret" }]),
    ).toBe('Column 1: invalid sensitivity "secret"');
  });

  it("rejects duplicate column names", () => {
    expect(
      validateColumns([
        validColumn,
        { ...validColumn, name: "id" },
      ]),
    ).toBe('Duplicate column name "id"');
  });

  it("accepts multiple valid columns", () => {
    expect(
      validateColumns([
        validColumn,
        { name: "email", data_type: "text", sensitivity: "searchable", is_owner: false },
        { name: "secret", data_type: "text", sensitivity: "private", is_owner: false },
      ]),
    ).toBeNull();
  });
});
