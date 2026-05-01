/**
 * SimpleClaw — Message format utilities
 * Normalizes platform-specific formatting to SimpleClaw's canonical shape.
 */

export class MessageFormatter {
  static escapeMarkdown(text: string): string {
    return text.replace(/([*_`[\]()])/g, "\\$1");
  }

  static truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + "...";
  }

  static codeBlock(text: string, lang = ""): string {
    return "```" + lang + "\n" + text + "\n```";
  }
}
