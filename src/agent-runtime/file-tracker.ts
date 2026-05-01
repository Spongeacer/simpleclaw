/**
 * SimpleClaw — File Access Tracker
 * Enforces read-before-write: a file must be read before it can be edited.
 * Tracks which files have been accessed in the current turn.
 */

export class FileAccessTracker {
  private accessed = new Set<string>();

  markRead(path: string): void {
    this.accessed.add(this.normalize(path));
  }

  hasRead(path: string): boolean {
    return this.accessed.has(this.normalize(path));
  }

  clear(): void {
    this.accessed.clear();
  }

  private normalize(p: string): string {
    return p.replace(/\\/g, "/").toLowerCase();
  }
}
