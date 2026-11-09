export type RoleName = "analyst" | "builder";

export interface RoleRequirements {
  description: string;
  tools: boolean;
  structuredOutput: boolean;
  minContext: number;
}

/**
 * analyst: may use REA (MCP tools) and writes the functional spec – "dirty room".
 * builder: sees only spec + measurements and writes DSP code – "clean room".
 */
export const ROLES: Record<RoleName, RoleRequirements> = {
  analyst: {
    description: "Analyses plugin metadata with REA and writes the functional spec (dirty room)",
    tools: true,
    structuredOutput: false,
    minContext: 32000,
  },
  builder: {
    description: "Writes and refines the clone's DSP code from spec and measurements (clean room)",
    tools: true,
    structuredOutput: true,
    minContext: 32000,
  },
};

export const ROLE_NAMES = Object.keys(ROLES) as RoleName[];

export function isRoleName(value: string): value is RoleName {
  return value in ROLES;
}
