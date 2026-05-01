/**
 * SimpleClaw — Skill Types
 * Extended metadata and eligibility types for production-grade skill management.
 */

export interface SkillMetadata {
  /** Always expose to model regardless of eligibility checks */
  always?: boolean;
  /** Emoji or icon for the skill */
  emoji?: string;
  /** Homepage / documentation URL */
  homepage?: string;
  /** OS platform restrictions (e.g. ["darwin", "linux"]) */
  os?: string[];
  /** Runtime requirements */
  requires?: {
    /** All of these commands must be available on PATH */
    bins?: string[];
    /** At least one of these commands must be available on PATH */
    anyBins?: string[];
    /** All of these environment variables must be set (non-empty) */
    env?: string[];
  };
  /** Installation hints (displayed only, never auto-executed) */
  install?: {
    kind: "brew" | "npm" | "pip" | "go" | "apt" | "manual";
    command?: string;
    label?: string;
  }[];
}

export interface SkillInfo {
  name: string;
  description: string;
  triggers?: string[];
  /** Absolute path to SKILL.md */
  location: string;
  /** Absolute path to skill directory (parent of SKILL.md) */
  baseDir: string;
  /** Markdown content after frontmatter */
  content: string;
  /** Parsed metadata block */
  metadata?: SkillMetadata;
  /** Whether the skill passes runtime eligibility checks */
  eligible: boolean;
  /** Human-readable reason if ineligible */
  ineligibleReason?: string;
  /** Source of the skill */
  source: SkillSource;
}

export type SkillSource = "builtin" | "workspace" | "user";

export interface SecurityLimits {
  /** Maximum bytes per SKILL.md file (default: 256KB) */
  maxSkillFileBytes: number;
  /** Maximum skills loaded per source (default: 100) */
  maxSkillsPerSource: number;
}

export const DEFAULT_SECURITY_LIMITS: SecurityLimits = {
  maxSkillFileBytes: 256_000,
  maxSkillsPerSource: 100,
};
