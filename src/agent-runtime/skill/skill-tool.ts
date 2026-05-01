/**
 * SimpleClaw — Skill Tool
 * Lets the agent load a specialized skill workflow into the conversation.
 */

import type { ITool, ILogger } from "../../core/interfaces.js";
import type { SkillInfo } from "./skill-types.js";

export function createSkillTool(skills: SkillInfo[], logger: ILogger): ITool {
  const eligibleSkills = skills.filter((s) => s.eligible);
  const skillMap = new Map(skills.map((s) => [s.name, s]));

  // Build install hints for tool description
  const availableList = eligibleSkills.length > 0
    ? eligibleSkills.map((s) => {
        const emoji = s.metadata?.emoji ? `${s.metadata.emoji} ` : "";
        const install = s.metadata?.install?.[0];
        const installHint = install ? ` (install: ${install.label ?? install.command ?? install.kind})` : "";
        return `  - ${s.name}: ${emoji}${s.description}${installHint}`;
      }).join("\n")
    : "  (none available on this system)";

  return {
    name: "skill",
    description: [
      "Load a specialized skill into the current conversation.",
      "",
      "When the user's task matches one of the skills below, call this tool FIRST",
      "to load the skill's workflow guidance before taking any other action.",
      "",
      "Available skills:",
      availableList,
      "",
      "Do NOT invoke for trivial tasks already covered by built-in tools.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The exact name of the skill to load (must match one listed above)",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const name = String(args.name);
      logger.info("Skill load", { name });

      const skill = skillMap.get(name);
      if (!skill) {
        const available = eligibleSkills.map((s) => s.name).join(", ") || "none";
        return `Skill "${name}" not found. Available skills: ${available}`;
      }

      if (!skill.eligible) {
        const install = skill.metadata?.install?.[0];
        const installHint = install
          ? `\nInstall: ${install.label ?? install.command ?? install.kind}`
          : "";
        return `Skill "${name}" is not available on this system. ${skill.ineligibleReason ?? ""}${installHint}`;
      }

      const lines: string[] = [
        `<skill_content name="${skill.name}">`,
        ``,
        `# Skill: ${skill.name}`,
        ``,
        skill.content.trim(),
        ``,
        `Base directory: ${skill.baseDir}`,
        `Relative paths in this skill are relative to the base directory.`,
        `</skill_content>`,
      ];

      return lines.join("\n");
    },
  };
}
