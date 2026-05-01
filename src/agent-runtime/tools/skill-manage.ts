/**
 * SimpleClaw — Skill Management Tool
 * Auto-create and patch reusable skills from successful task patterns.
 *
 * Skills are stored as Markdown files with YAML frontmatter in:
 *   ~/.simpleclaw/skills/{skill-name}/SKILL.md
 *
 * Format compatible with agentskills.io open standard.
 */

import { mkdir, readFile, writeFile, readdir } from "fs/promises";
import { join } from "path";
import type { ITool, ILogger } from "../../core/interfaces.js";

export interface SkillManageOptions {
  skillsDir: string;
  logger: ILogger;
  onChange?: () => void | Promise<void>;
}

interface SkillFrontmatter {
  name: string;
  description: string;
  tools?: string[];
  created?: string;
  updated?: string;
  auto_generated?: boolean;
  source_session?: string;
}

// Security patterns for skill content
const SKILL_THREAT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+instructions/i, reason: "prompt_injection" },
  { pattern: /you\s+are\s+now\s+/i, reason: "role_hijack" },
  { pattern: /system\s+prompt\s+override/i, reason: "sys_prompt_override" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, reason: "disregard_rules" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, reason: "exfil_curl" },
  { pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, reason: "exfil_wget" },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, reason: "read_secrets" },
  { pattern: /authorized_keys/i, reason: "ssh_backdoor" },
];

function scanSkillContent(content: string): { safe: boolean; reason?: string } {
  for (const { pattern, reason } of SKILL_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return { safe: false, reason };
    }
  }
  if (/[\u200B-\u200D\uFEFF]/.test(content)) {
    return { safe: false, reason: "invisible_unicode" };
  }
  return { safe: true };
}

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } | null {
  if (!content.startsWith("---\n")) return null;
  const endIdx = content.indexOf("\n---\n");
  if (endIdx === -1) return null;
  const fmText = content.slice(4, endIdx);
  const body = content.slice(endIdx + 5);

  // Simple YAML-like parser (key: value or key: [array])
  const frontmatter: Record<string, unknown> = {};
  for (const line of fmText.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else if (value === "true") {
      frontmatter[key] = true;
    } else if (value === "false") {
      frontmatter[key] = false;
    } else {
      frontmatter[key] = value.replace(/^["']|["']$/g, "");
    }
  }

  return { frontmatter: frontmatter as unknown as SkillFrontmatter, body };
}

function serializeSkill(frontmatter: SkillFrontmatter, body: string): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${frontmatter.name}`);
  lines.push(`description: ${frontmatter.description}`);
  if (frontmatter.tools && frontmatter.tools.length > 0) {
    lines.push(`tools: [${frontmatter.tools.join(", ")}]`);
  }
  if (frontmatter.created) lines.push(`created: ${frontmatter.created}`);
  if (frontmatter.updated) lines.push(`updated: ${frontmatter.updated}`);
  if (frontmatter.auto_generated) lines.push("auto_generated: true");
  if (frontmatter.source_session) lines.push(`source_session: ${frontmatter.source_session}`);
  lines.push("---");
  lines.push("");
  lines.push(body.trim());
  lines.push("");
  return lines.join("\n");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, content, "utf-8");
  const { rename } = await import("fs/promises");
  await rename(tmpPath, path);
}

export function createSkillManageTool(opts: SkillManageOptions): ITool {
  const { skillsDir, logger, onChange } = opts;

  return {
    name: "skill_manage",
    description:
      "Create or update reusable skills from successful task patterns. " +
      "Use this AFTER completing a complex task (5+ tool calls) to save the workflow for future reuse. " +
      "Skills are stored as Markdown files and automatically indexed for retrieval.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "patch", "read", "list"],
          description: "create=new skill, patch=update existing skill, read=view skill content, list=all skills in the user library",
        },
        name: {
          type: "string",
          description: "Skill name (kebab-case). Required for create/patch/read.",
        },
        description: {
          type: "string",
          description: "Short description (required for create)",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Tools used by this skill (optional)",
        },
        content: {
          type: "string",
          description: "Full markdown content for create, or patch instructions for patch. For patch, use format: FIND: <text>\nREPLACE: <text>",
        },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args.action);
      const name = args.name ? String(args.name) : undefined;

      logger.info("Skill manage", { action, name });

      // Ensure skills dir exists
      await mkdir(skillsDir, { recursive: true });

      if (action === "list") {
        try {
          const dirs = await readdir(skillsDir, { withFileTypes: true });
          const skills: string[] = [];
          for (const dir of dirs) {
            if (!dir.isDirectory()) continue;
            try {
              const skillPath = join(skillsDir, dir.name, "SKILL.md");
              const text = await readFile(skillPath, "utf-8");
              const parsed = parseFrontmatter(text);
              if (parsed) {
                skills.push(`${dir.name}: ${parsed.frontmatter.description} (updated: ${parsed.frontmatter.updated ?? "unknown"})`);
              }
            } catch { /* ignore unreadable */ }
          }
          if (skills.length === 0) return "No skills in user library yet.";
          return ["User library skills:", ""].concat(skills).join("\n");
        } catch {
          return "No skills in user library yet.";
        }
      }

      if (!name) {
        return "Error: 'name' is required for create/patch/read actions.";
      }

      const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const skillDir = join(skillsDir, safeName);
      const skillPath = join(skillDir, "SKILL.md");

      if (action === "read") {
        try {
          const text = await readFile(skillPath, "utf-8");
          return text;
        } catch {
          return `Skill '${name}' not found.`;
        }
      }

      if (action === "create") {
        if (!args.description || typeof args.description !== "string") {
          return "Error: 'description' is required for create.";
        }
        if (!args.content || typeof args.content !== "string") {
          return "Error: 'content' is required for create.";
        }

        const scan = scanSkillContent(args.content);
        if (!scan.safe) {
          return `Security scan failed: ${scan.reason}. Skill not created.`;
        }

        await mkdir(skillDir, { recursive: true });
        const now = new Date().toISOString().split("T")[0];
        const frontmatter: SkillFrontmatter = {
          name: safeName,
          description: args.description,
          tools: Array.isArray(args.tools) ? args.tools.map(String) : undefined,
          created: now,
          updated: now,
          auto_generated: true,
        };
        const fullContent = serializeSkill(frontmatter, args.content);
        await atomicWrite(skillPath, fullContent);
        logger.info("Skill created", { name: safeName, path: skillPath });
        if (onChange) {
          void Promise.resolve(onChange()).catch(() => {});
        }
        return `Skill '${safeName}' created successfully.\nPath: ${skillPath}`;
      }

      if (action === "patch") {
        if (!args.content || typeof args.content !== "string") {
          return "Error: 'content' is required for patch. Use format: FIND: <text>\nREPLACE: <text>";
        }

        let existing: string;
        try {
          existing = await readFile(skillPath, "utf-8");
        } catch {
          return `Skill '${name}' not found. Cannot patch.`;
        }

        // Parse patch instruction: FIND: <text>\nREPLACE: <text>
        const findMatch = args.content.match(/FIND:\s*([\s\S]*?)(?=\nREPLACE:|$)/);
        const replaceMatch = args.content.match(/REPLACE:\s*([\s\S]*)/);

        if (!findMatch) {
          // If no FIND/REPLACE format, append as new section
          const newContent = existing.trim() + "\n\n" + args.content.trim();
          const scan = scanSkillContent(newContent);
          if (!scan.safe) {
            return `Security scan failed: ${scan.reason}. Patch rejected.`;
          }
          const parsed = parseFrontmatter(existing);
          if (parsed) {
            parsed.frontmatter.updated = new Date().toISOString().split("T")[0];
            await atomicWrite(skillPath, serializeSkill(parsed.frontmatter, newContent.slice(newContent.indexOf("---\n", 3) + 4).trim()));
          } else {
            await atomicWrite(skillPath, newContent);
          }
          logger.info("Skill patched (append)", { name: safeName });
          return `Skill '${safeName}' updated (appended new section).`;
        }

        const findText = findMatch[1].trim();
        const replaceText = replaceMatch ? replaceMatch[1].trim() : "";

        if (!existing.includes(findText)) {
          return `Patch failed: could not find the specified text in skill '${name}'.`;
        }

        const patched = existing.replace(findText, replaceText);
        const scan = scanSkillContent(patched);
        if (!scan.safe) {
          return `Security scan failed: ${scan.reason}. Patch rejected.`;
        }

        // Backup original
        await atomicWrite(skillPath + ".bak", existing);

        const parsed = parseFrontmatter(patched);
        if (parsed) {
          parsed.frontmatter.updated = new Date().toISOString().split("T")[0];
          await atomicWrite(skillPath, serializeSkill(parsed.frontmatter, parsed.body));
        } else {
          await atomicWrite(skillPath, patched);
        }
        logger.info("Skill patched", { name: safeName });
        if (onChange) {
          void Promise.resolve(onChange()).catch(() => {});
        }
        return `Skill '${safeName}' patched successfully. Original backed up to ${skillPath}.bak`;
      }

      return `Unknown action: ${action}`;
    },
  };
}
