import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

export type DocumentName = "manifest" | "parameters" | "test-signals" | "captures";

export const DOCUMENT_FILES: Record<DocumentName, string> = {
  manifest: "manifest.json",
  parameters: "parameters.json",
  "test-signals": "test-signals.json",
  captures: "captures.json",
};

export class ProfileValidationError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(details.length > 0 ? `${message}\n  ${details.join("\n  ")}` : message);
    this.name = "ProfileValidationError";
    this.details = details;
  }
}

const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
const validators = new Map<DocumentName, ValidateFunction>();

export function loadSchema(name: DocumentName): object {
  const url = new URL(`../schema/${name}.schema.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as object;
}

function validator(name: DocumentName): ValidateFunction {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile(loadSchema(name));
    validators.set(name, validate);
  }
  return validate;
}

/** Throws ProfileValidationError if `data` does not match the schema of the given document. */
export function validateDocument(name: DocumentName, data: unknown): void {
  const validate = validator(name);
  if (!validate(data)) {
    const details = (validate.errors ?? []).map((e) => `${DOCUMENT_FILES[name]}${e.instancePath || "/"} ${e.message ?? ""}`.trim());
    throw new ProfileValidationError(`${DOCUMENT_FILES[name]} is invalid`, details);
  }
}
